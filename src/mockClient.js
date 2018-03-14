import { exists } from 'fs';

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
    channels.unshift(new Channel(new Date().getTime().toString()));
    return channels[0];

  }
}

class Channel extends events.EventEmitter {
  constructor(id) {
    super();

    this.id = id;
    this.queues = {};

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
      resolve();
    } else {
      reject("queue doesn't exist");
    }
    });
  } 
  }

} 