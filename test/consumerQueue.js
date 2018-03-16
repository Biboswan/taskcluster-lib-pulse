class ConsumerQueue {
  constructor(queueName, options = {}) {
    super();

    this.exchanges = {};
    this.queueName = queueName;
    this.exclusive = options.exclusive !='undefined'? options.exclusive:false;
    this.durable = options.durable !='undefined'? options.durable: true;
    this.autoDelete = options.autoDelete !='undefined'? options.autoDelete: false;
    this.maxLength = options.maxLength || 20;
    this.queue = [];
    this.reset();
  }
  
  subscribe(exchange, routingkeypattern) {
    if (this.exchanges.hasOwnProperty(exchange)) {
      this.exchanges[exchange].add(routingkeypattern);
    } else {
      this.exchanges[exchange] = new Set(routingkeypattern);
    }

  }

  reset() {
	  this.tail = -1;
	  this.head = -1;
  };
  
  increment(number) {
	  return (number + 1) % this.maxLength;
  }

  enQueue(record) {
    if (this.isFull()) {
      this.deQueue();
      this.enQueue(record);
    }
    
    if (this.isEmpty()) {
      this.head = this.increment(this.head);
    }
    
    this.tail = this.increment(this.tail);
    //console.log("tail", this.tail);
    this.queue[this.tail] = record;
  }

  deQueue() {
    if (this.isEmpty()) {
      throw new Error('Cant remove');
    }
    
    // removing from the begining of the head
    var removedRecord = this.queue[this.head];
    this.queue[this.head] = null;
    
    if (this.tail === this.head) {
      this.reset();
    } else {
      // if there are more records increase head.	
      this.head = this.increment(this.head);
    }
    
    return removedRecord;
  }

  peep() {
    return this.queue[this.head] || null;
  }

  isFull() {
    return this.increment(this.tail) === this.head;
  }

  isEmpty() {
    return this.tail === -1 && this.head === -1;
  }
}

exports.ConsumerQueue = ConsumerQueue;