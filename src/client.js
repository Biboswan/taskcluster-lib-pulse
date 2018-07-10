const events = require('events');
const debug = require('debug');
const amqplib = require('amqplib');
const assert = require('assert');
const {URL} = require('url');
var clientCounter = 0;

/**
 * An object to create connections to a pulse server.  This class will
 * automatically handle reconnecting as necessary.
 *
 * AMQP is a very connection-oriented protocol.  For example, a client using
 * non- durable queues will need to re-declare those queues on every new
 * connection.  Similarly, a consumer must re-start consumption on every new
 * connection.  This class emits a `connected` event on each new
 * connection, and that function should re-establish any state as required for
 * the new connection.
 *
 * Connections are automatically cycled periodically, regardless of any problems
 * with the connection itself, in order to exercise the reconnection logic. When
 * this occurs, the old connection is held open for 30 seconds to allow any pending
 * publish operations or message consumptions to complete.
 *
 * Options:
 * * credentials (async function )
 * * recycleInterval (ms; default 1h)
 * * retirementDelay (ms; default 30s)
 * * minReconnectionInterval (ms; default 15s)
 * * monitor (taskcluster-lib-monitor instance)
 *
 * The pulse namespace for this user is available as `client.namespace`.
 */
class Client extends events.EventEmitter {
  constructor({recycleInterval, retirementDelay, minReconnectionInterval, monitor, credentials}) {
    super();

    assert(monitor, 'monitor is required');
    this.monitor = monitor;

    this.credentials = credentials;

    this._recycleInterval = recycleInterval || 3600 * 1000;
    this._retirementDelay = retirementDelay || 30 * 1000;
    this._minReconnectionInterval = minReconnectionInterval || 15 * 1000;
    this.running = false;
    this.connections = [];
    this.lastConnectionTime = 0;

    this.id = ++clientCounter;
    this.debug = debug(`taskcluster-lib-pulse.client-${this.id}`);

    this.debug('starting');
    this.running = true;
    this.recycle();

    this._interval = setInterval(
      () => this.recycle(),
      this._recycleInterval);
  }

  async stop() {
    assert(this.running, 'Not running');
    this.debug('stopping');
    this.running = false;

    clearInterval(this._interval);
    this._interval = null;

    this.recycle();

    // wait until all existing connections are finished
    const unfinished = this.connections.filter(conn => conn.state !== 'finished');
    if (unfinished.length > 0) {
      await Promise.all(unfinished.map(
        conn => new Promise(resolve => { conn.once('finished', resolve); })));
    }
  }

  /**
   * Create a new connection, retiring any existing connection.
   */
  recycle() {
    this.debug('recycling');

    if (this.connections.length) {
      const currentConn = this.connections[0];
      currentConn.retire();
    }

    if (this.running) {
      const newConn = new Connection(this);

      // don't actually start connecting until at lesat minReconnectionInterval has passed
      const earliestConnectionTime = this.lastConnectionTime + this._minReconnectionInterval;
      const now = new Date().getTime();
      setTimeout(() => {
        this.lastConnectionTime = new Date().getTime();
        newConn.connect();
      }, now < earliestConnectionTime ? earliestConnectionTime - now : 0);

      newConn.once('connected', () => {
        this.emit('connected', newConn);
      });
      newConn.once('finished', () => {
        this.connections = this.connections.filter(conn => conn !== newConn);
      });
      this.connections.unshift(newConn);
    }
  }

  /**
   * Get a full object name, following the Pulse security model,
   * `<kind>/<namespace>/<name>`.  This is useful for manipulating these objects
   * directly, for example to modify the bindings of an active queue.
   */
  fullObjectName(kind, name) {
    assert(kind, 'kind is required');
    assert(name, 'name is required');
    return `${kind}/${this.namespace}/${name}`;
  }

  /**
   * Listen for a `connected` event, but call the handler with the existing connection
   * if this client is already connected.
   */
  onConnected(handler) {
    const res = this.on('connected', handler);
    const conn = this.activeConnection;
    if (conn) {
      handler(conn);
    }
    return res;
  }

  /**
   * The active connection, if any.  This is useful when starting to use an already-
   * running client:
   *   client.on('connected', setupConnection);
   *   if (client.activeConnection) {
   *     await setupConnection(client.activeConnection);
   *   }
   */
  get activeConnection() {
    if (this.running && this.connections.length && this.connections[0].state === 'connected') {
      return this.connections[0];
    }
  }

  /**
   * Run the given async function with a connection.  This is similar to
   * client.once('connected', ..), except that it will fire immediately if
   * the client is already connected.  This does *not* automatically re-run
   * the function if the connection fails.
   */
  withConnection(fn) {
    if (this.activeConnection) {
      return fn(this.activeConnection);
    }

    return new Promise((resolve, reject) => {
      this.once('connected', conn => Promise.resolve(fn(conn)).then(resolve, reject));
    });
  }

  /**
   * Run the given async function with an amqplib channel or confirmChannel. This wraps
   * withConnection to handle closing the channel.
   */
  withChannel(fn, {confirmChannel} = {}) {
    return this.withConnection(async conn => {
      const method = confirmChannel ? 'createConfirmChannel' : 'createChannel';
      const channel = await conn.amqp[method]();

      // consider any errors on the channel to be potentially fatal to the whole
      // connection, out of an abundance of caution
      channel.on('error', () => this.recycle());

      try {
        return await fn(channel);
      } finally {
        try {
          await channel.close();
        } catch (err) {
          // an error trying to close the channel suggests the connection is dead, so
          // recycle, but continue to throw the first error
          this.recycle();
        }
      }
    });
  }
}

exports.Client = Client;

/**
 * A fake client is basically just a semaphore for users like PulseConsumer to
 * invoke their own fakery.
 */
class FakeClient {
  constructor() {
    this.isFakeClient = true;
  }
}

exports.FakeClient = FakeClient;

let nextConnectionId = 1;

/**
 * A single connection to a pulse server.  This is a thin wrapper around a raw
 * AMQP connection, instrumented to inform the parent Client of failures
 * and trigger a reconnection.  It is possible to have multiple Connection
 * objects in the same process at the same time, while one is being "retired" but
 * is lingering around to send ack's for any in-flight message handlers.
 *
 * The instance's `amqp` property is the amqp connection object.  In the event of any
 * issues with the connection, call the instance's `failed` method.  This will initiate
 * a retirement of the connection and creation of a new connection.
 *
 * The instance will emit a `connected` event when it connects to the pulse server.
 * This event occurs before the connection is provided to a user, so it is only
 * of interest to the Client class.
 *
 * This instance will emit a `retiring` event just before it is retired.  Users
 * should cancel consuming from any channels, as a new connection will soon
 * begin consuming.  Errors from such cancellations should be logged and
 * ignored.  This connection will remain open for 30 seconds to allow any
 * in-flight message processing to complete.
 *
 * The instance will emit `finished` when the connection is finally closed.
 *
 * A connection's state can be one of
 *
 *  - waiting -- waiting for a call to connect() (for minReconnectionInterval)
 *  - connecting -- waiting for a connection to complete
 *  - connected -- connection is up and running
 *  - retiring -- in the process of retiring
 *  - finished -- no longer connected
 *
 *  Note that an instance that fails to connect will skip from `connecting` to
 *  `retiring`.
 *
 */
class Connection extends events.EventEmitter {
  constructor(client) {
    super();

    this.client = client;
    this.id = nextConnectionId++;
    this.amqp = null;

    this.debug = debug(`taskcluster-lib-pulse.conn-${this.id}`);

    this.debug('waiting');
    this.state = 'waiting';
  }

  async connect() {
    if (this.state !== 'waiting') {
      return;
    }

    this.debug('connecting');
    this.state = 'connecting';

    if (!this.connectionString) {
      await setConnStringNamespace();
      if (this.client._recycleAfter) {
        setTimeout(callreclaim = async () => {
          await setConnStringNamespace(this.client);
          // Refresh the normal recycle interval since a new connection is established by other means
          clearInterval(this.client._interval);
          this.client._interval = null;
          this.client._interval = setInterval(
            () => this.client.recycle(),
            interval);
          setTimeout(callreclaim, this.client.recycleAfter);
        }, this.client._recycleAfter);
      }
    }

    const amqp = await amqplib.connect(this.connectionString, {
      heartbeat: 120,
      noDelay: true,
      timeout: 30 * 1000,
    }).catch(err => {
      this.debug(`Error while connecting: ${err}`);
      this.failed();
    });

    if (amqp) {
      if (this.state !== 'connecting') {
        // we may have been retired already, in which case we do not need this
        // connection
        amqp.close();
        return;
      }
      this.amqp = amqp;

      amqp.on('error', err => {
        if (this.state === 'connected') {
          this.debug(`error from aqplib connection: ${err}`);
          this.failed();
        }
      });

      amqp.on('close', err => {
        if (this.state === 'connected') {
          this.debug('connection closed unexpectedly');
          this.failed();
        }
      });

      this.debug('connected');
      this.state = 'connected';
      this.emit('connected');
    }
  }

  failed() {
    if (this.state === 'retired' || this.state === 'finished') {
      // failure doesn't matter at this point
      return;
    }
    this.debug('failed');
    this.client.recycle();
  }

  retire() {
    if (this.state === 'retiring' || this.state === 'finished') {
      return;
    }

    this.debug('retiring');
    this.state = 'retiring';
    this.emit('retiring');

    // actually close this connection 30 seconds later
    setTimeout(() => {
      this.debug('finished; closing AMQP connection');
      if (this.amqp) {
        // ignore errors in close
        this.amqp.close().catch(err => {});
      }
      this.amqp = null;
      this.state = 'finished';
      this.emit('finished');
    }, this.client._retirementDelay);
  }

  /**
   * Using credentials set value of connectionstring of Connection object, namespace of client
   * and _recycleAfter of client.
   * recycleAfter is the recycle interval which may be suggested by the service from which 
   * credentials are claimed
   */
  async setConnStringNamespace() {
    const credentials = await this.client.credentials();
    this.connectionString = credentials.connectionString;
    const connURL = new URL(connectionString);
    this.client.namespace = decodeURI(connURL.username);
    this.client._recycleAfter = credentials.recycleAfter;
  }
}

exports.Connection = Connection;
