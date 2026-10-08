// Spike client: mic capture + one RTCPeerConnection via the 2-peer relay.
const $ = (id) => document.getElementById(id);
const log = (...parts) => { $('log').textContent += parts.join(' ') + '\n'; };
const setStatus = (s) => { $('status').textContent = s; log('status:', s); };

let ws, pc, localStream;
let queue = Promise.resolve();
const remoteListeners = [];

export function onRemoteStream(cb) { remoteListeners.push(cb); }

// ?fake: a beeping tone instead of the mic, for automated checks and solo listening tests.
function fakeToneStream() {
  const ctx = new AudioContext();
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  const gate = new GainNode(ctx, { gain: 0 });
  for (let t = 0; t < 3600; t += 1) {
    gate.gain.setValueAtTime(0.3, ctx.currentTime + t);
    gate.gain.setValueAtTime(0, ctx.currentTime + t + 0.3);
  }
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gate).connect(dest);
  osc.start();
  return dest.stream;
}

const send = (obj) => ws.send(JSON.stringify(obj));

function newPeerConnection() {
  pc?.close();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.onicecandidate = (e) => { if (e.candidate) send({ kind: 'ice', candidate: e.candidate }); };
  window.spike = { pc };
  pc.onconnectionstatechange = () => setStatus(pc.connectionState);
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    for (const cb of remoteListeners) cb(stream);
  };
}

async function handle(m) {
  if (m.type === 'role') {
    newPeerConnection();
    if (m.role === 'offer') {
      await pc.setLocalDescription();
      send({ kind: 'sdp', sdp: pc.localDescription });
      setStatus('offer sent');
    } else {
      setStatus('waiting for peer');
    }
  } else if (m.type === 'peer-joined') {
    newPeerConnection();
    setStatus('peer joined, awaiting offer');
  } else if (m.type === 'peer-left') {
    newPeerConnection();
    setStatus('peer left, waiting for peer');
  } else if (m.kind === 'sdp') {
    await pc.setRemoteDescription(m.sdp);
    if (m.sdp.type === 'offer') {
      await pc.setLocalDescription();
      send({ kind: 'sdp', sdp: pc.localDescription });
    }
  } else if (m.kind === 'ice') {
    await pc.addIceCandidate(m.candidate).catch((err) => log('ice error', err.message));
  }
}

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    localStream = new URLSearchParams(location.search).has('fake')
      ? fakeToneStream()
      : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
  } catch (err) {
    setStatus('mic error: ' + err.message);
    $('start').disabled = false;
    return;
  }
  log('mic settings', JSON.stringify(localStream.getAudioTracks()[0].getSettings()));
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); queue = queue.then(() => handle(m)); };
  ws.onclose = (e) => setStatus(`socket closed ${e.code} ${e.reason}`);
};

// Baseline playback (Task 3): remote stream straight into an <audio> element.
onRemoteStream((stream) => {
  const el = $('remote');
  el.srcObject = stream;
  el.play().catch((err) => log('play error', err.message));
});
