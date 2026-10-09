// Test double for the slice of Web Audio the engine uses: records connections and param automation.
export class FakeParam {
  targets: [number, number, number][] = [];
  constructor(public value = 0) {}
  setTargetAtTime(value: number, time: number, tau: number) {
    this.targets.push([value, time, tau]);
    this.value = value;
    return this;
  }
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  get last() {
    return this.targets.at(-1);
  }
}

export class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  constructor(readonly kind: string) {}
  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
    this.connections = [];
  }
}

export class FakeAudioContext {
  currentTime = 1;
  sampleRate = 48000;
  state: AudioContextState = 'running';
  resumes = 0;
  nodes: FakeNode[] = [];
  destination = new FakeNode('destination');
  listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(-1),
    upX: new FakeParam(),
    upY: new FakeParam(1),
    upZ: new FakeParam(),
  };
  /** Time-domain samples every analyser reports. */
  analyserData = new Float32Array(512);

  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.track(Object.assign(new FakeNode('gain'), { gain: new FakeParam(1) }));
  }
  createBiquadFilter() {
    return this.track(Object.assign(new FakeNode('biquad'), { type: 'lowpass', frequency: new FakeParam(350) }));
  }
  createPanner() {
    return this.track(
      Object.assign(new FakeNode('panner'), {
        panningModel: 'equalpower',
        distanceModel: 'inverse',
        rolloffFactor: 1,
        positionX: new FakeParam(),
        positionY: new FakeParam(),
        positionZ: new FakeParam(),
      })
    );
  }
  createConvolver() {
    return this.track(Object.assign(new FakeNode('convolver'), { buffer: null as unknown }));
  }
  createAnalyser() {
    const data = this.analyserData;
    return this.track(
      Object.assign(new FakeNode('analyser'), {
        fftSize: 2048,
        getFloatTimeDomainData(out: Float32Array) {
          out.set(data.subarray(0, out.length));
        },
      })
    );
  }
  createMediaStreamSource(mediaStream: MediaStream) {
    return this.track(Object.assign(new FakeNode('source'), { mediaStream }));
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  byKind(kind: string) {
    return this.nodes.filter((n) => n.kind === kind) as (FakeNode & Record<string, unknown>)[];
  }
}

export const asAudioContext = (ctx: FakeAudioContext) => ctx as unknown as AudioContext;
