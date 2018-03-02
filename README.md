# taskcluster-lib-pulse

Library for interacting with Pulse and Taskcluster-Pulse.  See [the
docs](https://docs.taskcluster.net/manual/design/apis/pulse) for more
information on Pulse.

# Usage

This library defines a Client along with several classes and functions that
base their functionality on a Client.  The Client represents an association
with a Pulse service, automatically reconnecting as necessary.

The higher-level components are:

* [PulseQueue](#PulseQueue)

If you are using one of the higher-level components, then the details of
interacting with a Client are not important -- just construct one and move on.

# Client

Create a `Client` to handle (re)connecting to Pulse:

```javascript
const pulse = require('taskcluster-lib-pulse');

const client = new pulse.Client({
  connectionString: 'amqps://...',
});
// or
const client = new pulse.Client({
  username: 'sendr',
  password: 'sekrit',
  hostname: 'pulse.mycompany.com',
});
```

The `Client` is responsible for connecting, and re-connecting, to the pulse
server. Once started, it will do so automatically until stopped.

Other options to the constructor:

 * `recycleInterval` - interval on which connections are automatically recycled, in ms.  Default: 1 hour.
 * `retirementDelay` - time that a connection remains in the `retiring` state.

## Interacting With a Client

AMQP is a very connection-oriented protocol, so as a user of this library, you
will need to set up each new connection.  To do so, set up an event listener
for the `connected` event from the client:

```javascript
client.on('connected', conn => {
  // ...
});
```

The `conn` value of this event is a `Connection` instance, from this library.
The amqplib connection is available as `conn.amqp`. The listener should create
any necessary channels, declare queues and exchanges, and - if consuming
messages - bind to those queues.

Note that declaring non-durable queues in this method may lead to message loss
or duplication: when this connection fails, the server will delete the queues
and any pending tasks.  If this is not acceptable for your application, use a
durable queue.

The library cannot detect all problems with an existing connection.  If any
method produces an error that might be fixed by reconnecting, call the
connection's `failed` method.  This will mark the connection as failed and
begin cretaing a new connection (culminating in another `connected` event).

## Active Connection

If a consumer might begin consuming after a Client has been started,
`client.on('connected', setup)` is not enough -- `setup` will not be called
until the next reconnection.  In this case, the `activeConnection` property is
useful, giving the current active connection (or undefined, in which case there
will soon be an active connection)

```javascript
client.on('connected', setup);
if (client.activeConnection) {
  setup(client.activeConnection);
}
```

## Manipulating AMQP Objects

If you have a one-off task that requires a connection, such as declaring an
exchange,

use `client.withChannel`, which will wait for a connection if necessary, then
run your function with an amqplib channel or confirmChannel. If the function
fails, it is not automatically retried, but the channel is closed.

```javascript
await client.withChannel(channel => { .. }, {confirmChannel: true});
await client.withChannel(channel => { .. }, {confirmChannel: false});
```

There is also a more general `withConnection` which returns the `Connection`
instance without creating a channel.

```javascript
await client.withConnection(conn => { .. });
```

The most common use case for these functions is to declare or delete objects on
the AMQP server. For example:

```javascript
await client.withChannel(async chan => {
  const exchangeName = client.objectName('exchange', 'notable-things');
  await chan.assertExchange(exchangeName, 'topic');
});
```

This uses the `objectName` method to generate an exchange name compatible with
the pulse access control model.

## Reconnection

The `Client` instance will automatically reconnect periodically. This helps
to distribute load across a cluster of servers, and also exerciess the
reconnection logic in the application, avoiding nasty surprises when a network
or server failure occurs.

The `Client` also has a `recycle` method that will trigger a retirement and
reconnection.

## Retirement

When a connection is still working, but a new connection is being created, the
old connection spends 30 seconds "retiring". The intent of this delay is to
allow any ongoing message handling to complete before closing the underlying
AMQP connection.

The `Connection` instance emits a `retiring` event when retirement begins.
Consumers should respond to this message by cancelling any channel consumers.
The `retiring` event from the `Connection` will be followed by a
`connected` event from the `Client` for the next connection.

## Shutdown

Call the async `Client.stop` method to shut the whole thing down. This will
wait until all existing `Connection` instances are finished their retirement.

## Examples

### Consumer

To consume messages, listen for `connected` messages and set up a new
channel on each new connection.  Stop consuming from the channel on retirement,
allowing time for any in-flight consumption to complete before the connection
is finished.

The whole thing is wrapped in a try/catch so that any errors in connection
setup are treated as a connection failure.


```javascript
client.on('connected', async (conn) => {
  let channel, consumer;

  try {
    const amqp = conn.amqp;
    channel = await amqp.createChannel();
    await channel.assertExchange(exchangeName, 'topic');
    await channel.assertQueue(queueName);
    await channel.bindQueue(queueName, exchangeName, routingKeyPattern);

    consumer = await channel.consume(queueName, (msg) => {
      // do something with the message, then ack it..
      channel.ack(msg);
    });

    conn.on('retiring', () => {
      // ignore errors in this call: the connection is already retiring..
      channel.cancel(consumer.consumerTag).catch(() => {});
    });
  } catch (err) {
    debug('error in connected listener: %s', err);
    conn.failed();
  }
});

client.start();
```

# PulseQueue

A PulseQueue declares a queue and listens for messages on that
queue, invoking a callback for each messages.

The options to the constructor are:

```javascript
let pq = new pulse.PulseQueue({
  client,                // Client object for connecting to the server
  bindings: [{           // exchange/routingKey patterns to bind to
    exchange,            // Exchange to bind
    routingKeyPattern,   // Routing key as string
    routingKeyReference, // Reference used to parse routing keys (optional)
  }, ..],
  handleMessage,         // handler for incoming messages
  queueName,             // Queue name, defaults to exclusive auto-delete queue
  prefetch,              // Max number of messages unacknowledged to hold (optional)
  maxLength,             // Maximum queue size, undefined for none
}
```

if `routingKeyReference` is provided for the exchange from which messages
arrive the listener will parse the routing key and make it available as a
dictionary on the message.  Note that bindings are easily constructed using the
taskcluster-client library.

When a message is received, `handleMessage` is called (asynchronously) with
a message of the form:

```javascript
{
  payload,       // parsed payload (as JSON)
  exchange,      // exchange name
  routingKey:    // primary routing key
  redelivered:   // true if this message has already been attempted
  routes: [..]   // additional routes (from CC header, with the `route.`
                 // prefix stripped)
  routing: {}    // parsed routes (if routingKeyReference is provided)
}
```

If the handler fails, the message will be re-queued and re-tried once.

Listening starts immediately, or when the client starts.

## Routing Key Reference

A binding's `routingKeyReference` gives reference information for the format of
a routing key, and allows the tool to "parse" a message's routing key into
components.  It is an array of objects with properties `name`, the name of the
component, and `multipleWords` if the component can match multiple words
(joined with a `.`).  Other fields are ignored.  Only one component can have
`multipleWords`.  This is compatible with the references produced by
taskcluster services.

```javascript
routingKeyReference: [
  {name: 'routingKeyKind'},
  {name: 'someId', multipleWords: true},
]
```

If this parameter is given, the message will have a `routing` property
containing the routing key components keyed by their name.

The library assumes that all messages on a given exchange share the same
routing key reference, as it is not practical to determine which
routingKeyPattern matched a particular message.

# Testing

To run the tests, a simple `yarn test` will do.  But it will skip most of the tests!

Better to run against a real RabbitAMQP server.  If you have Docker, that's easy:

```
docker run -d -ti --rm -p 5672:5672 rabbitmq:alpine
export PULSE_CONNECTION_STRING=amqp://guest:guest@localhost:5672/
```
