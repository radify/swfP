#!/usr/bin/env node

var {
  createContext,
  runInContext
} = require('vm');

var {ActivityPoller} = require('aws-swf');
var {hostname} = require('os');
var {readFile} = require('fs');
var bluebird   = require('bluebird');
var yargs      = require('yargs');

var options = yargs
  .usage('Usage: $0 [options]')
  .option('file', {
    alias: 'f',
    describe: 'Javascript file containing activities object'
  })
  .option('domain', {
    alias: 'd',
    describe: 'Name of the SWF Domain to execute activities within'
  })
  .option('taskList', {
    alias: 't',
    describe: 'Name of the SWF Task List to execute activities for'
  })
  .option('identity', {
    alias: 'i',
    describe: 'Unique identifier of this worker instance',
    default: `activity-${hostname()}-${process.pid}`
  })
  .demand(['file', 'domain', 'taskList'])
  .argv;

const readFileP = bluebird.promisify(readFile);

const parse = str => {
  try {
    return JSON.parse(str);
  } catch(e) {
    return str;
  }
};

const execute = (file, activityTask) =>
  bluebird
    .all([readFileP(file), activityContext(activityTask)])
    .then(([code, context]) => {
      runInContext(code, context);

      var {name} = activityTask.config.activityType;

      var activity = context.exports[name];
      if (!activity) {
        throw Error(`Activity '${name}' not defined in '${file}'`);
      }

      var input  = parse(activityTask.config.input);

      console.log(
        `Executing activity '${name}'`,
        activityTask.config.input
      );

      return bluebird.resolve(activity(input));
    });

const activityContext = activityTask => createContext({
  Promise: bluebird
});

var worker = new ActivityPoller({
  domain: options.domain,
  identity: options.identity,
  taskList: {name: options.taskList}
});

worker.on('activityTask', activityTask => {
  console.log('Received activity task');

  execute(options.file, activityTask)
    .tap(result => console.log('Activity execution succeeded', result))
    .catch(err => {
      console.error('Activity execution failed', err);
      activityTask.respondFailed(err.name, err);
      throw err;
    })
    .then(result => activityTask.respondCompleted(result));
});

worker.on('poll', () => console.log('Polling for activity tasks...'));

console.log(`Starting activity worker '${options.identity}' for task list '${options.taskList}' in domain '${options.domain}'`);

worker.start();
process.on('SIGINT', () => {
  console.log('Caught SIGINT, polling will stop after current request...');
  worker.stop();
});