class ConsumerQueue {
  constructor(queueName, options = {}) {
    super();

    this.exchanges = {};
    this.queueName = queueName;
    this.options.exclusive = options.exclusive !='undefined'? options.exclusive:false;
    this.options.durable = options.durable !='undefined'? options.durable: true;
    this.options.autoDelete = options.autoDelete !='undefined'? options.autoDelete: false;
    this.options.maxLength = options.maxLength;
  }
  
  subscribe(exchange, routingkeypattern) {
    if (this.exchanges.hasOwnProperty(exchange)) {
      this.exchanges[exchange].push(routingkeypattern);
    } else {
      this.exchanges[exchange] = [];
    }

  }
}

exports.ConsumerQueue = ConsumerQueue;