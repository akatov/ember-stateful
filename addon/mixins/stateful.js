import Ember from 'ember';
import { task, taskGroup } from 'ember-concurrency';
import ERRORS from 'ember-stateful/errors';

const { computed } = Ember;

const WAIT_HERE_FOREVER = Ember.RSVP.defer().promise;

function isThenable(obj) {
  return obj && typeof(obj.then) === 'function';
}

function executeStateHook(target, hook) {
  let ret;
  if (hook) {
    ret = hook.call(target);
  }
  if (!isThenable(ret)) {
    ret = Ember.RSVP.resolve();
  }
  return ret;
}

function isReservedProperty(name) {
  return ['_try', '_catch', '_finally', '_default'].includes(name)
}

function isStateHash(name, obj) {
  return !isReservedProperty(name) && typeof(obj) !== 'function';
}

function isAction(name, obj) {
  return !isReservedProperty(name) && typeof(obj) === 'function';
}

function getSuperStateName(stateName) {
  if (stateName === '_root') {
    return null;
  }
  if (!stateName.includes('.')) {
    return '_root';
  }
  return stateName.split('.').slice(0, -1).join('.');
}

function getStateTaskName(stateName) {
  if (stateName === '_root') {
    return '_state_root';
  }
  return `_state_${stateName.split('.').join('_')}`;
}

function getStateTaskGroupPropertyName(stateName) {
  if (stateName === '_root') {
    return '_taskgroup_root';
  }
  return `_taskgroup_${stateName.split('.').join('_')}`;
}

function isStateTaskName(name) {
  return name.startsWith('_state_');
}

function findSubStates(stateHash) {
  return Object.entries(stateHash).filter(([name, val]) => isStateHash(name, val));
}

function findDefaultSubState([stateName, stateHash]) {
  const subStates = findSubStates(stateHash);
  if (subStates.length === 0) {
    return null;
  }
  if (subStates.length === 1) {
    const [subState] = subStates;
    return subState;
  }
  const defaultSubStates = subStates
    .filter(([, hash]) => hash._default === true)
  if (defaultSubStates.length === 0) {
    throw new Error(ERRORS.DEFAULT_SUBSTATE_NOT_DEFINED(stateName))
  }
  if (defaultSubStates.length > 1) {
    throw new Error(ERRORS.MULTIPLE_DEFAULT_SUBSTATES(stateName, defaultSubStates));
  }
  const [defaultSubState] = defaultSubStates;
  return defaultSubState;
}

function getFullStateName(stateName, fullSuperStateName) {
  return fullSuperStateName === '_root'
    ? stateName
    : [fullSuperStateName, stateName].join('.');
}

function getStateNameFromStateTaskName(stateTaskName) {
  if (stateTaskName.endsWith('_root')){
    return '_root';
  }
  const [, state] = stateTaskName.match(/^_state_(\w+)/);
  return state.split('_').join('.');
}

function initializeState(target, stateHash, stateName, fullSuperStateName) {
  // initialize
  const fullStateName = getFullStateName(stateName, fullSuperStateName);

  // create task group for potential substates of this task
  target.set(getStateTaskGroupPropertyName(fullStateName), taskGroup().restartable());

  // create the state task
  let stateTask = task(function*(...args){
    yield* stateTaskFunction(target, fullStateName, ...args);
  });

  // add the state task to the superstate task group
  if (fullStateName !== '_root') {
    stateTask = stateTask.group(getStateTaskGroupPropertyName(fullSuperStateName));
  }

  // save task
  target.set(getStateTaskName(fullStateName), stateTask);

  // find the default substate
  const defaultSubState = findDefaultSubState([fullStateName, stateHash]);
  if (defaultSubState !== null) {
    const [defaultSubStateName, ] = defaultSubState;
    target._defaultStateMapping[fullStateName] = getFullStateName(defaultSubStateName, fullStateName);
  }

  // put state actions at the top to be able to call them from components
  const actions = Object.entries(stateHash).filter(([key, val]) => isAction(key, val));
  for (const [name, ] of actions) {
    if (Ember.isNone(target.actions[name])) {
      target.actions[name] = function(...args) {
        this.send(name, ...args);
      }
    }
  }
  const subStates = findSubStates(stateHash);
  for (const [name, hash] of subStates) {
    initializeState(target, hash, name, fullStateName);
  }
}

/**
 * @see https://github.com/emberjs/ember.js/blob/v2.14.1/packages/ember-views/lib/mixins/action_support.js
 */

function initializeStateHierarchy(target) {
  target._defaultStateMapping = {};
  const actions = Object.assign({}, target.actions);
  initializeState(target, actions, '_root', '_root');
  target.actions._root = actions;
}

function* stateTaskFunction(target, stateName, shouldStartDefaultSubtask = true) {
  if (stateName !== '_root') {
    const superStateName = getSuperStateName(stateName);
    const superState = target._getStateTask(superStateName);
    if (!superState.get('isRunning')) {
      // during transitions into a deeply nested structure the superstates will not
      // be running so kick them off first
      superState.perform(false);
    }
  }

  const stateActions = target.get(`actions.${stateName}`) || {};
  try {
    target.trigger(`try_${stateName}`);
    yield executeStateHook(target, stateActions._try);
    if (shouldStartDefaultSubtask) {
      const defaultStateName = target._getDefaultStateName(stateName);
      if (defaultStateName) {
        const defaultStateTask = target._getStateTask(defaultStateName);
        // we're cascading down until we hit a leaf state
        defaultStateTask.perform(true);
      }
    }
    // never ending yield to keep the task running
    yield WAIT_HERE_FOREVER;
  } catch(e) {
    // TODO: bubble the exception up
    if (stateActions._catch) {
      stateActions._catch(e);
    } else {
      throw e;
    }
  } finally {
    // we are exiting so cancel the task group
    target.get(getStateTaskGroupPropertyName(stateName)).cancelAll();
    target.trigger(`finally_${stateName}`);
    yield executeStateHook(target, stateActions._finally);
  }
}

export default Ember.Mixin.create(Ember.Evented, {
  /**
   * If the current State is 'a.b.c', this property is `{ a: { b: { c: {}}}}`
   * The idea is to simplify state checks, e.g.
   * `if (this.get('state.a.b')) { ... }` will work in state 'a.b.c' and 'a.b.d',
   * epsecially for templates.
   *
   * @property {Object} state
   */
  state: computed('currentState', function() {
    const ret = this.get('currentState').split('.').reduceRight((acc, s) => {
      return { [s]: acc };
    }, {});
    return ret;
  }),

  _stateTaskNames: computed(function () {
    return Object.keys(this)
      .filter(isStateTaskName)
      .map(key => ({
        key,
        val: this.get(key),
      }))
      .map(x => x.key)
      .map(x => (x === '_state_root' ? '_state' : x)) // state_root is actually the topmost state
      .map(x => x.split('_'))
      .sort((x, y) => x.length < y.length)
      .map(x => x.join('_'))
      .map(x => (x === '_state' ? '_state_root' : x)); // bring back proper name for state_root
  }),

  _stateNames: computed('_stateTaskNames', function() {
    const stateTaskNames = this.get('_stateTaskNames');
    return stateTaskNames.map(getStateNameFromStateTaskName);
  }),

  _defaultStateMapping: undefined,

  init(...args) {
    this._super(...args);
    initializeStateHierarchy(this);
    this._getStateTask('_root').perform(true);
    const stateTaskNames = this.get('_stateTaskNames') ;
    Object.defineProperty(this, 'currentState', {
      value: computed(...stateTaskNames.map(stateTask => `${stateTask}.isRunning`), function() {
        const stateTaskNames = this.get('_stateTaskNames');
        const runningStateTaskName = stateTaskNames.find(
          stateTaskName => this.get(`${stateTaskName}.isRunning`)
        );
        if (!runningStateTaskName) {
          throw new Error(ERRORS.NO_RUNNING_STATE());
        }
        return getStateNameFromStateTaskName(runningStateTaskName);
      }),
    });
    // kick off the computed properties
    this.get('state');
    this.get('currentState');
  },

  send(actionName, ...args) {
    let stateParts = this.get('currentState').split('.');
    let shouldBubble = true;

    while(shouldBubble && stateParts.length > 0) {
      const action = this.get(`actions._root.${stateParts.join('.')}.${actionName}`);
      if (action) {
        shouldBubble = action.apply(this, args) === true;
      }
      stateParts.pop();
    }
    if (shouldBubble) {
      const rootAction = this.actions._root[actionName];
      if (!rootAction) {
        throw new Error(ERRORS.NO_ROOT_ACTION(actionName, this));
      }
      rootAction.apply(this, args);
    }
  },

  transitionTo(stateName) {
    if (!this._checkIfStateExists(stateName)) {
      throw new Error(ERRORS.NO_SUCH_STATE(stateName));
    }
    this._getStateTask(stateName).perform(true);
  },


  _getStateTask(stateName) {
    return this.get(getStateTaskName(stateName));
  },

  _getDefaultStateName(stateName) {
    return this._defaultStateMapping[stateName];
  },

  _checkIfStateExists(stateName) {
    const stateNames = this.get('_stateNames');
    return stateNames.includes(stateName);
  },
});
