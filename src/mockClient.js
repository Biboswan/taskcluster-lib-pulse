const events = require('events');
const debug = require('debug');
const assert = require('assert');

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
  constructor() {
    super();
    
  }
}
class Channel extends events.EventEmitter {
  constructor() {
    super();
    this.exchanges = [];
    this.queue = [];
  }

} 