/**
 * Mock WebRTC RTCPeerConnection, RTCDataChannel, and paired signaling bus helpers
 * for deterministic unit tests without browser WebRTC engines or live servers.
 */

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dispatchEventListeners(listenerMap, propHandler, eventName, eventObj) {
  if (typeof propHandler === 'function') {
    propHandler(eventObj);
  }
  const listeners = listenerMap.get(eventName);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of [...listeners]) {
    listener(eventObj);
  }
}

export function createMockDataChannel(label = 'shipri-diagnostic', options = {}) {
  const listeners = new Map();
  const channel = {
    label,
    ordered: options.ordered !== undefined ? Boolean(options.ordered) : true,
    readyState: options.readyState ?? 'connecting',
    sentMessages: [],
    closeCalls: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,

    addEventListener(type, listener) {
      if (typeof listener !== 'function') {
        return;
      }
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },

    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },

    send(data) {
      if (channel.readyState !== 'open') {
        throw new Error('Cannot send on a non-open mock RTCDataChannel.');
      }
      channel.sentMessages.push(data);
    },

    close() {
      channel.closeCalls += 1;
      if (channel.readyState === 'closed') {
        return;
      }
      channel.readyState = 'closed';
      dispatchEventListeners(listeners, channel.onclose, 'close', {
        type: 'close',
        target: channel,
      });
    },

    simulateOpen() {
      channel.readyState = 'open';
      dispatchEventListeners(listeners, channel.onopen, 'open', {
        type: 'open',
        target: channel,
      });
    },

    simulateMessage(data) {
      dispatchEventListeners(listeners, channel.onmessage, 'message', {
        type: 'message',
        data,
        target: channel,
      });
    },

    simulateError(error) {
      dispatchEventListeners(listeners, channel.onerror, 'error', {
        type: 'error',
        error,
        target: channel,
      });
    },
  };

  return channel;
}

export function createMockPeerConnection(config = {}, behavior = {}) {
  const listeners = new Map();
  let offerCounter = 0;
  let answerCounter = 0;

  let pendingOfferDeferred = null;
  let pendingAnswerDeferred = null;
  let pendingSetLocalDeferred = null;
  let pendingSetRemoteDeferred = null;

  const pc = {
    config,
    signalingState: 'stable',
    iceGatheringState: 'new',
    iceConnectionState: 'new',
    connectionState: 'new',
    localDescription: null,
    remoteDescription: null,
    createdDataChannels: [],
    addedIceCandidates: [],
    closeCalls: 0,
    closed: false,

    onicecandidate: null,
    onicegatheringstatechange: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    onsignalingstatechange: null,
    ondatachannel: null,

    addEventListener(type, listener) {
      if (typeof listener !== 'function') {
        return;
      }
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },

    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },

    createDataChannel(label, options = {}) {
      if (pc.closed) {
        throw new Error('Cannot createDataChannel on a closed RTCPeerConnection.');
      }
      const channel = createMockDataChannel(label, options);
      pc.createdDataChannels.push(channel);
      return channel;
    },

    async createOffer() {
      if (pc.closed) {
        throw new Error('Cannot createOffer on a closed RTCPeerConnection.');
      }
      if (behavior.deferCreateOffer) {
        pendingOfferDeferred = createDeferred();
        const customOffer = await pendingOfferDeferred.promise;
        if (customOffer) {
          return customOffer;
        }
      }
      offerCounter += 1;
      return {
        type: 'offer',
        sdp: [
          'v=0',
          `o=- ${1000 + offerCounter} 2 IN IP4 203.0.113.10`,
          's=-',
          'a=ice-ufrag:mockOfferUfrag',
          'a=ice-pwd:mockOfferSecretIcePwd',
        ].join('\r\n'),
      };
    },

    async createAnswer() {
      if (pc.closed) {
        throw new Error('Cannot createAnswer on a closed RTCPeerConnection.');
      }
      if (behavior.deferCreateAnswer) {
        pendingAnswerDeferred = createDeferred();
        const customAnswer = await pendingAnswerDeferred.promise;
        if (customAnswer) {
          return customAnswer;
        }
      }
      answerCounter += 1;
      return {
        type: 'answer',
        sdp: [
          'v=0',
          `o=- ${2000 + answerCounter} 2 IN IP4 198.51.100.20`,
          's=-',
          'a=ice-ufrag:mockAnswerUfrag',
          'a=ice-pwd:mockAnswerSecretIcePwd',
        ].join('\r\n'),
      };
    },

    async setLocalDescription(description) {
      if (pc.closed) {
        throw new Error(
          'Cannot setLocalDescription on a closed RTCPeerConnection.',
        );
      }
      if (behavior.deferSetLocalDescription) {
        pendingSetLocalDeferred = createDeferred();
        await pendingSetLocalDeferred.promise;
        if (pc.closed) {
          throw new Error(
            'RTCPeerConnection closed during setLocalDescription.',
          );
        }
      }
      pc.localDescription = {
        type: description.type,
        sdp: description.sdp,
      };
      pc.signalingState =
        description.type === 'offer' ? 'have-local-offer' : 'stable';
      dispatchEventListeners(
        listeners,
        pc.onsignalingstatechange,
        'signalingstatechange',
        { type: 'signalingstatechange', target: pc },
      );

      if (behavior.gatheringStateOnLocalDescription !== null) {
        const nextGathering =
          behavior.gatheringStateOnLocalDescription ?? 'gathering';
        if (nextGathering !== pc.iceGatheringState) {
          pc.iceGatheringState = nextGathering;
          dispatchEventListeners(
            listeners,
            pc.onicegatheringstatechange,
            'icegatheringstatechange',
            { type: 'icegatheringstatechange', target: pc },
          );
        }
      }
    },

    async setRemoteDescription(description) {
      if (pc.closed) {
        throw new Error(
          'Cannot setRemoteDescription on a closed RTCPeerConnection.',
        );
      }
      if (behavior.deferSetRemoteDescription) {
        pendingSetRemoteDeferred = createDeferred();
        await pendingSetRemoteDeferred.promise;
        if (pc.closed) {
          throw new Error(
            'RTCPeerConnection closed during setRemoteDescription.',
          );
        }
      }
      pc.remoteDescription = {
        type: description.type,
        sdp: description.sdp,
      };
      pc.signalingState =
        description.type === 'offer' ? 'have-remote-offer' : 'stable';
      dispatchEventListeners(
        listeners,
        pc.onsignalingstatechange,
        'signalingstatechange',
        { type: 'signalingstatechange', target: pc },
      );
    },

    async addIceCandidate(candidate) {
      if (pc.closed) {
        throw new Error('Cannot addIceCandidate on a closed RTCPeerConnection.');
      }
      if (!pc.remoteDescription) {
        const err = new Error(
          'InvalidStateError: remoteDescription must be set before addIceCandidate.',
        );
        err.name = 'InvalidStateError';
        throw err;
      }
      pc.addedIceCandidates.push(candidate);
    },

    setMockStats(customStats) {
      behavior.stats = customStats;
    },

    async getStats() {
      if (behavior.stats) {
        return behavior.stats;
      }

      const candidateType =
        config.iceTransportPolicy === 'relay' ? 'relay' : 'srflx';
      return new Map([
        [
          'mock-pair',
          {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: 'mock-local',
            remoteCandidateId: 'mock-remote',
          },
        ],
        [
          'mock-local',
          {
            type: 'local-candidate',
            candidateType,
          },
        ],
        [
          'mock-remote',
          {
            type: 'remote-candidate',
            candidateType,
          },
        ],
      ]);
    },

    close() {
      pc.closeCalls += 1;
      if (pc.closed) {
        return;
      }
      pc.closed = true;
      pc.signalingState = 'closed';
      pc.iceConnectionState = 'closed';
      pc.connectionState = 'closed';
      for (const ch of pc.createdDataChannels) {
        ch.close();
      }
      dispatchEventListeners(
        listeners,
        pc.onsignalingstatechange,
        'signalingstatechange',
        { type: 'signalingstatechange', target: pc },
      );
      dispatchEventListeners(
        listeners,
        pc.oniceconnectionstatechange,
        'iceconnectionstatechange',
        { type: 'iceconnectionstatechange', target: pc },
      );
      dispatchEventListeners(
        listeners,
        pc.onconnectionstatechange,
        'connectionstatechange',
        { type: 'connectionstatechange', target: pc },
      );
    },

    resolvePendingOffer(customOffer) {
      pendingOfferDeferred?.resolve(customOffer);
    },

    rejectPendingOffer(error) {
      pendingOfferDeferred?.reject(error);
    },

    resolvePendingAnswer(customAnswer) {
      pendingAnswerDeferred?.resolve(customAnswer);
    },

    resolvePendingSetLocalDescription() {
      pendingSetLocalDeferred?.resolve();
    },

    resolvePendingSetRemoteDescription() {
      pendingSetRemoteDeferred?.resolve();
    },

    simulateIceCandidate(candidate) {
      if (candidate === null) {
        pc.simulateIceGatheringStateChange('complete');
      }
      dispatchEventListeners(listeners, pc.onicecandidate, 'icecandidate', {
        type: 'icecandidate',
        candidate,
        target: pc,
      });
    },

    simulateIceGatheringStateChange(nextState) {
      pc.iceGatheringState = nextState;
      dispatchEventListeners(
        listeners,
        pc.onicegatheringstatechange,
        'icegatheringstatechange',
        { type: 'icegatheringstatechange', target: pc },
      );
    },

    simulateIceConnectionStateChange(nextState) {
      pc.iceConnectionState = nextState;
      dispatchEventListeners(
        listeners,
        pc.oniceconnectionstatechange,
        'iceconnectionstatechange',
        { type: 'iceconnectionstatechange', target: pc },
      );
    },

    simulateConnectionStateChange(nextState) {
      pc.connectionState = nextState;
      dispatchEventListeners(
        listeners,
        pc.onconnectionstatechange,
        'connectionstatechange',
        { type: 'connectionstatechange', target: pc },
      );
    },

    simulateRemoteDataChannel(label = 'shipri-diagnostic', options = {}) {
      const channel = createMockDataChannel(label, options);
      pc.createdDataChannels.push(channel);
      dispatchEventListeners(listeners, pc.ondatachannel, 'datachannel', {
        type: 'datachannel',
        channel,
        target: pc,
      });
      return channel;
    },
  };

  return pc;
}

export function createMockPeerConnectionFactory(defaultBehavior = {}) {
  const instances = [];

  function factory(config) {
    const behavior =
      typeof defaultBehavior === 'function'
        ? defaultBehavior(instances.length, config)
        : defaultBehavior;
    const pc = createMockPeerConnection(config, behavior);
    instances.push(pc);
    return pc;
  }

  factory.instances = instances;
  Object.defineProperty(factory, 'lastInstance', {
    enumerable: true,
    get() {
      return instances.length > 0 ? instances[instances.length - 1] : null;
    },
  });

  return factory;
}
