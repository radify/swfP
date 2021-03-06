#!/usr/bin/env node

var {Decider}  = require('aws-swf');
var {hostname} = require('os');
var bluebird   = require('bluebird');
var yargs      = require('yargs');

var {load} = require('./common');

bluebird.config({
  cancellation: true
});

const wait = () => new Promise(resolve => setImmediate(resolve));

var options = yargs
  .usage('Usage: $0 [options]')
  .option('file', {
    alias: 'f',
    describe:  'Javascript file containing decider promise chain'
  })
  .option('domain', {
    alias: 'd',
    describe: 'Name of the SWF Domain to execute decisions within'
  })
  .option('taskList', {
    alias: 't',
    describe: 'Name of the SWF Task List to execute decisions for'
  })
  .option('identity', {
    alias: 'i',
    describe: 'Unique identifier of this decider instance',
    default: `decider-${hostname()}-${process.pid}`
  })
  .option('limit', {
    alias: 'l',
    describe: 'Limit the number of decider processes that can run concurrently'
  })
  .demand(['file', 'domain', 'taskList'])
  .argv;

const execute = (file, decisionTask) =>
  load(file)
    .then(module => {
      if (typeof module === 'function') {
        return module;
      }

      if (typeof module.default === 'function') {
        return module.default;
      }

      throw new TypeError(`${file} is not a function`);
    })
    .then(decider => ({
      decider: decider(
        decisionTask.eventList.workflow_input(),
        context(decisionTask)
      )
    }))
    .tap(wait);

const context = decisionTask => ({
  Promise: bluebird,

  activity: (name, input, options = {}) =>
    new bluebird.Promise((resolve, reject) => {
      if (!decisionTask.eventList.is_activity_scheduled(name)) {
        console.log(`Scheduling activity '${name}'`);

        let schedule = Object.assign({
          name,
          input,
          activity: name
        }, options);

        return decisionTask.response.schedule(schedule);
      }

      if (decisionTask.eventList.has_activity_completed(name)) {
        console.log(`Activity '${name}' has completed`);
        return resolve(decisionTask.eventList.results(name));
      }

      if (decisionTask.eventList.has_activity_failed(name)) {
        console.error(`Activity '${name}' has failed`);
        return reject(decisionTask.eventList.results(name));
      }

      console.log(`Waiting for activity '${name}' to finish`);
      return decisionTask.response.wait();
    }),

  timer: (name, seconds) =>
    new bluebird.Promise(resolve => {
      if (!decisionTask.eventList.timer_scheduled(name)) {
        console.log(`Scheduling timer '${name}'`);

        return decisionTask.response.start_timer({
          delay: seconds
        }, {
          timerId: name
        });
      }

      if (decisionTask.eventList.timer_fired(name)) {
        console.log(`Timer '${name}' has fired`);
        return resolve();
      }

      console.log(`Waiting for timer '${name}'`);
      return decisionTask.response.wait();
    }),

  childWorkflow: (name, input, options) =>
    new bluebird.Promise((resolve, reject) => {
      if (!decisionTask.eventList.childworkflow_scheduled(name)) {
        console.log(`Scheduling child workflow '${name}'`);

        let schedule = Object.assign({
          name,
          workflow: name
        }, options);

        return decisionTask.response.start_childworkflow(schedule, {input});
      }

      if (decisionTask.eventList.childworkflow_completed(name)) {
        console.log(`Child workflow '${name}' has completed`);
        return resolve(decisionTask.eventList.childworkflow_results(name));
      }

      if (decisionTask.eventList.childworkflow_failed(name)) {
        console.error(`Child workflow '${name}' has failed`);
        return reject(decisionTask.eventList.childworkflow_results(name));
      }

      console.log(`Waiting for child workflow '${name}' to finish'`);
      return decisionTask.response.wait();
    }),

  signal: name =>
    new bluebird.Promise(resolve => {
      if (decisionTask.eventList.signal_arrived(name)) {
        console.log(`Signal '${name}' has been received`);
        return resolve(decisionTask.eventList.signal_input(name));
      }

      console.log(`Waiting for signal '${name}'`);
      return decisionTask.response.wait();
    })
});

const handleDecisionState = ({response}) => ({decider}) => {
  /**
   * The decider promise is still pending after this execution, so cancel
   * it to prevent it from being settled on a subsequent decision execution
   */
  if (decider.isPending()) {
    decider.cancel();
    return console.log('Workflow execution is still pending');
  }

  /**
   * The decider promise has been fulfilled, which means that the workflow
   * should be marked as completed
   */
  if (decider.isFulfilled()) {
    response.stop({
      result: decider.value()
    });

    return console.log('Workflow execution has succeeded');
  }

  /**
   * The decider promise has been rejected, which means that the workflow should
   * be marked as failed. Due to inconsistency in the `aws-swf` library, the
   * decision must be manually added to the decision list instead of using
   * `.fail()`
   */
  if (decider.isRejected()) {
    let reason = decider.reason();

    response.addDecision({
      decisionType: 'FailWorkflowExecution',
      failWorkflowExecutionDecisionAttributes: {
        reason,
        details: reason
      }
    });

    return console.log('Workflow execution has failed');
  }
};

var decider = new Decider({
  domain: options.domain,
  identity: options.identity,
  taskList: {name: options.taskList},
  taskLimitation: options.limit,
  maximumPageSize: 500,
  reverseOrder: false
});

decider.on('decisionTask', decisionTask => {
  console.log('Received decision task');

  execute(options.file, decisionTask)
    .tap(() => console.log('Decision execution finished'))
    .catch(err => {
      console.error('Decision execution failed', err);
      throw err;
    })
    .then(handleDecisionState(decisionTask))
    .then(() => {
      console.log('Sending decision response');
      return bluebird.fromCallback(cb => decisionTask.response.send(cb));
    })
    .then(() => console.log('All done!'));
});

decider.on('poll', () => console.log('Polling for decision tasks...'));

console.log(`Starting decider '${options.identity}' for task list '${options.taskList}' in domain '${options.domain}'`);

decider.start();
process.on('SIGINT', () => {
  console.log('Caught SIGINT, polling will stop after current request...');
  decider.stop();
});
