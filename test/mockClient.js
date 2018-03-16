const {ConsumerQueue} = require('consumerQueue');
const events = require('events');
const debug = require('debug');
const assert = require('assert');
const slugid = require('slugid');

var clientcounter = 0;

class MockClient extends events.EventEmitter {
  constructor(monitor) {
    super();
    this.monitor = monitor;
    this.connections = [];
    this.connectionCounter = 0;
    this.namespace = `guest${clientcounter}`;
    this.running = true;
    this.id = ++clientCounter;
    this.activeConnection;
    this.recycle();

  }

  fullObjectName(kind, name) {
    return `${kind}/${this.namespace}/${name}`;
  }

  stop() {
    this.running = false;
    this.recycle();
  }

  recycle() {
    if (this.connections.length) {
      const currentConn = this.connections[0];
      currentConn.retire();
    }

    if (this.running) {
      const newConn = new Connection(this, ++this.connectionCounter);

      newConn.once('connected', () => {
        this.emit('connected', newConn);
      });
      newConn.once('finished', () => {
        this.connections = this.connections.filter(conn => conn.id !== newConn.id);
      });
      this.connections.unshift(newConn);
    }
  }

  get activeConnection() {
    if (this.running && this.connections.length && this.connections[0].state === 'connected') {
      return this.connections[0];
    }
  }

  withConnection(fn) {
    if (this.activeConnection) {
      return fn(this.activeConnection);
    }

    return new Promise((resolve, reject) => {
      this.once('connected', conn => Promise.resolve(fn(conn)).then(resolve, reject));
    });
  }

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

exports.MockClient = MockClient;

class Connection extends events.EventEmitter {
  constructor(client, id) {
    super();

    this.client = client;
    this.id = id;
    this.state = 'waiting';
    this.amqp = null;
  }

  connect() {
    this.amqp = new MockAMQP(id);
    this.state = 'connected';
    this.emit('connected');
  }

  retire() {
    this.state = 'retiring';
    this.emit('retiring');
    this.amqp = null;
    this.state = 'finished';
    this.emit('finished');
  }

  failed() {
    if (this.state === 'finished') {
      return;
    }
    this.client.recycle();
  }
}

class MockAMQP extends events.EventEmitter {
  constructor() {
    super();
    this.channels = [];
  }

  createChannel() {
    return new Promise(resolve => {
      channels.unshift(new Channel(new Date().getTime().toString(), this));
      return resolve(channels[0]);
    });

  }
}

class Channel extends events.EventEmitter {
  constructor(id) {
    super();

    this.id = id;
    this.queues = {};
    this.prefetchcount = null;

  }

  assertQueue(queue = null, options = {}) {
    if (!queue) {
      queue = slugid.v4();
    }
    this.queues[queue] = new ConsumerQueue(queue, options);
    
    return Promise.resolve({
      queue,
      messageCount: 0,
      consumerCount: 0,
    });
  }

  bindQueue(queue, source, pattern) {
    return new Promise((resolve, reject) => { 
      if (this.queues.hasOwnProperty(queue)) {
        this.queues[queue].subscribe(source, pattern);
        resolve('ok');
      } else {
        reject('queue do not exist');
      }
    });
  }

  prefetch(count) {
    this.prefetchcount = count;
  }

  publish(exchange, routingKey, content, options = {}) {
    return new Promise((resolve, reject) => {
      this.queues.map(queue => {
        if (queue.exchanges.hasOwnProperty(exchange)) {
          queue.exchanges[exchange].map(pattern => {

            queue.enQueue({exchange, routingKey, content, options});
          });
        } 
      });
      resolve();
    });
  }

  consume(queue, fn) {
    if (this.queues.hasOwnProperty(queue)) {


    }

  }
  ack(msg) {

  }
  close() {
    this.emit('close');
  }

} 