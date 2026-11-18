/**
 * Register a persistent or one-time listener for a socket event.
 * @param {Map<string, Array<{ listener: Function, once: boolean }>>} listenersByEvent
 * @param {string} event
 * @param {Function} listener
 * @param {boolean} once
 */
function addListener(listenersByEvent, event, listener, once) {
  if (typeof listener !== 'function') {
    throw new TypeError(`Expected listener for "${event}" to be a function.`);
  }

  const entries = listenersByEvent.get(event) ?? [];
  entries.push({ listener, once });
  listenersByEvent.set(event, entries);
}

/**
 * Remove one listener, all listeners for an event, or all listeners on the socket.
 * @param {Map<string, Array<{ listener: Function, once: boolean }>>} listenersByEvent
 * @param {string} [event]
 * @param {Function} [listener]
 */
function removeListener(listenersByEvent, event, listener) {
  if (event === undefined) {
    listenersByEvent.clear();
    return;
  }

  if (listener === undefined) {
    listenersByEvent.delete(event);
    return;
  }

  const entries = listenersByEvent.get(event);
  if (!entries) {
    return;
  }

  const remaining = entries.filter((entry) => entry.listener !== listener);
  if (remaining.length > 0) {
    listenersByEvent.set(event, remaining);
  } else {
    listenersByEvent.delete(event);
  }
}

/**
 * Count registered listeners for a specific event or across all events.
 * @param {Map<string, Array<{ listener: Function, once: boolean }>>} listenersByEvent
 * @param {string} [event]
 * @returns {number}
 */
function countListeners(listenersByEvent, event) {
  if (event !== undefined) {
    return listenersByEvent.get(event)?.length ?? 0;
  }

  let total = 0;
  for (const entries of listenersByEvent.values()) {
    total += entries.length;
  }
  return total;
}

/**
 * Dispatch an event to registered listeners, pruning one-time handlers before execution.
 * @param {Map<string, Array<{ listener: Function, once: boolean }>>} listenersByEvent
 * @param {string} event
 * @param {...unknown} args
 */
function dispatchEvent(listenersByEvent, event, ...args) {
  const entries = listenersByEvent.get(event);
  if (!entries || entries.length === 0) {
    return;
  }

  // Snapshot entries and prune once listeners before invoking callbacks so
  // nested listener edits do not skip handlers or re-trigger once hooks.
  const snapshot = [...entries];
  const remaining = entries.filter((entry) => !entry.once);
  if (remaining.length > 0) {
    listenersByEvent.set(event, remaining);
  } else {
    listenersByEvent.delete(event);
  }

  for (const entry of snapshot) {
    entry.listener(...args);
  }
}

/**
 * Create an in-memory Socket.IO client mock for unit tests without live network connections.
 * @param {{ id?: string, connected?: boolean }} [options]
 * @returns {object} Mock socket with Socket.IO lifecycle methods and test simulation helpers.
 */
export function createMockSocket(options = {}) {
  const listenersByEvent = new Map();
  const emittedEvents = [];

  const socket = {
    id: options.id ?? 'mock-socket',
    connected: Boolean(options.connected),
    emittedEvents,
    connectCalls: 0,
    disconnectCalls: 0,

    on(event, listener) {
      addListener(listenersByEvent, event, listener, false);
      return socket;
    },

    once(event, listener) {
      addListener(listenersByEvent, event, listener, true);
      return socket;
    },

    off(event, listener) {
      removeListener(listenersByEvent, event, listener);
      return socket;
    },

    removeAllListeners(event) {
      removeListener(listenersByEvent, event);
      return socket;
    },

    getListenerCount(event) {
      return countListeners(listenersByEvent, event);
    },

    emit(event, ...args) {
      emittedEvents.push({ event, args });
      return socket;
    },

    clearEmitted() {
      emittedEvents.length = 0;
    },

    connect() {
      socket.connectCalls += 1;
      if (!socket.connected) {
        socket.simulateConnect();
      }
      return socket;
    },

    disconnect() {
      socket.disconnectCalls += 1;
      if (socket.connected) {
        socket.simulateDisconnect('io client disconnect');
      } else {
        socket.connected = false;
      }
      return socket;
    },

    simulateConnect() {
      socket.connected = true;
      dispatchEvent(listenersByEvent, 'connect');
    },

    simulateDisconnect(reason = 'transport close') {
      socket.connected = false;
      dispatchEvent(listenersByEvent, 'disconnect', reason);
    },

    simulateConnectError(error) {
      socket.connected = false;
      dispatchEvent(listenersByEvent, 'connect_error', error);
    },

    simulateServerEvent(event, ...args) {
      dispatchEvent(listenersByEvent, event, ...args);
    },
  };

  return socket;
}

/**
 * Create a callable Socket.IO client factory mock that records connection URLs and options.
 * @param {{ idPrefix?: string }} [defaults]
 * @returns {Function} Factory matching `io(url, options)` with `calls` and `lastSocket` inspection.
 */
export function createMockSocketFactory(defaults = {}) {
  const idPrefix = defaults.idPrefix ?? 'mock-socket';
  const calls = [];

  function mockIoFactory(url, options) {
    const socket = createMockSocket({
      id: options?.id ?? `${idPrefix}-${calls.length + 1}`,
    });
    calls.push({ url, options, socket });
    return socket;
  }

  mockIoFactory.calls = calls;
  Object.defineProperty(mockIoFactory, 'lastSocket', {
    enumerable: true,
    get() {
      return calls.length > 0 ? calls[calls.length - 1].socket : null;
    },
  });

  return mockIoFactory;
}
