# swfP

**A framework for building applications on AWS SWF using Promises**

swfP makes it easier to build decision and activity workers on AWS SWF by using
Promises (via Bluebird) in two ways:

- Workflow definition

  A decider is implemented as a Promise chain. By treating primitives such as
  activities, timers and child workflows as Promises, it becomes easy to
  implement parallel and serial execution with `.all()` and `.then()`

- Activity execution

  An activity's implementation may return a Promise. This allows an activity to
  declare success or failure based upon fulfillment or rejection.

## Usage

Install with:

```
npm install --save swfp
```

### Decider

A decider is implemented as a module, which exports a single function.
When called, this function should return a Promise, like so:

```javascript
module.exports = (input, schedule) =>
  schedule.Promise
    .all([
  	  schedule.activity('firstUpper', input),
	  schedule.activity('restLower', input)
    ])
    .then(parts => schedule.activity('concat', parts));
```

The decider function accepts parameters `input` (which refers to the
original workflow input) and `schedule`, which exposes the following
properties: 

- `Promise`
  Refers to Bluebird instead of the ES6 implementation

- `activity(name, input, options)`
  Starts an activity named `name` with input parameter `input`. Additional,
  optional SWF attributes may be specified with `options`.

  Returns a Promise which is resolved with the returned result of the Activity
  when it completed, or rejects with the error when it fails.

- `timer(name, seconds)`
  Starts a Timer with `name`.

  Returns a Promise which resolves to `null` after `seconds` have elasped.

- `childWorkflow(name, input, options)`
  Starts an activity named `name` with input parameter `input`. Additional,
  optional SWF attributes may be specified with `options`.

  Returns a Promise which is resolved with the returned result of the Workflow
  when it completed, or rejects with the error when it fails.

- `signal(name)`
  Returns a Promise which is resolved to the value given when a signal named
  `name` was called on the current Workflow execution

You can then start a worker for this decider by invoking the following command:

```
swfp-decider --file=./decider.js --domain=myDomain --taskList=myTasks
```

### Activity Worker

An activity worker exports an object containing activity implementations, like so:

```javascript
module.exports = {
	firstUpper: str => str[0].toUpperCase(),
	restLower:  str => str.substring(1).toLowerCase(),
	concat:     str => str.join('')
};
```

Each exported function accepts a single parameter, which is the input value
that was supplied to the activity's invocation when it was executed by the
Workflow.

Each exported function may do one of the following:

- Return a non-Promise value to mark the execution as successful
- Throw an Error to mark the execution as failed
- Return a Promise to mark the execution as succesful or failed when the
  Promise is settled

You can then start a worker for these activites by invoking the following command:

```
swfp-worker --file=./tasks.js --domain=myDomain --taskList=myTasks
```

### Caveats and Notes

- The Promise chain that a Decider exports only gives the *illusion* of a
  persistent state; the Decision poller destroys the object at the end of each
  decision execution.
- If you use any Promises within the Decider outside of those described here,
  they *must resolve before the next tick*, or the decider will hang.
- If you need to execute long-running code, implement it as an Activity instead.
