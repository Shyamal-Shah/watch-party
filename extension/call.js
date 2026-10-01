const $ = id => document.getElementById(id);
let view = null;
let wanted = false;
let joining = false;
let mediaBusy = false;
let generation = 0;
let roomKey = '';
let session = null;
let config = null;
let peer = null;
let attempts = 0;
let message = '';
let speakersMuted = false;
let registerPending = false;
let port;
let devicesReady = false;
let outputBusy = false;
let deviceRefresh = 0;
const deviceChoices = { audio: '', video: '', output: '' };
const deviceNames = { audio: 'Microphone', video: 'Camera', output: 'Speakers' };
const deviceKinds = { audio: 'audioinput', video: 'videoinput', output: 'audiooutput' };
const hasOutputSelection = typeof HTMLMediaElement.prototype.setSinkId === 'function';
const localStream = new MediaStream();
const tracks = { audio: null, video: null };
const live = kind => tracks[kind]?.readyState === 'live';
const currentKey = () => view?.party ? `${view.party.relayUrl}|${view.party.code}` : '';
const other = () => view?.room?.participants.find(p => p.id !== view.meId);
async function request(packet) {
  const response = await chrome.runtime.sendMessage(packet);
  if (response?.rpcError) throw new Error(response.rpcError);
  return response;
}
function render() {
  const friend = other();
  const online = view?.status === 'connected';
  $('room-label').textContent = view?.party ? `Room ${view.party.code} · ${view.room?.participants.filter(p => p.online).length || 0} / 2 watching` : 'No active watch party';
  $('join-controls').hidden = wanted || joining;
  $('call-controls').hidden = !wanted && !joining;
  $('join-voice').disabled = $('listen').disabled = !devicesReady || !online || !view?.room?.capabilities?.voiceVideo;
  $('mic').disabled = $('camera').disabled = mediaBusy || joining || !wanted;
  $('retry-call').disabled = !online || joining;
  $('mic').textContent = live('audio') ? 'Mute mic' : 'Turn mic on';
  $('camera').textContent = live('video') ? 'Turn camera off' : 'Turn camera on';
  $('mic').setAttribute('aria-pressed', String(live('audio')));
  $('camera').setAttribute('aria-pressed', String(live('video')));
  $('speaker').setAttribute('aria-pressed', String(speakersMuted));
  $('speaker').textContent = speakersMuted ? 'Unmute speakers' : 'Mute speakers';
  $('local-media').textContent = `Microphone ${live('audio') ? 'on' : 'off'} · Camera ${live('video') ? 'on' : 'off'}`;
  $('local-placeholder').hidden = live('video');
  $('remote-name').textContent = friend?.name || 'Your friend';
  $('remote-media').textContent = friend?.call ? `${friend.call.mic ? 'Mic on' : 'Mic off'} · ${friend.call.camera ? 'Camera on' : 'Camera off'}` : 'Not in call';
  $('remote-placeholder').hidden = !!friend?.call?.camera && peer?.pc.connectionState === 'connected';
  $('remote-placeholder').textContent = friend?.call ? 'Camera off' : 'Waiting for your friend';
  let status = 'Join voice or listen only. You can turn on your camera during the call.';
  if (!view?.party) status = 'Your party ended. Microphone and camera are off.';
  else if (!view.room?.capabilities?.voiceVideo && online) status = 'Update the relay to enable voice and video calls.';
  else if (joining) status = 'Waiting for microphone permission…';
  else if (wanted && !online) status = 'Reconnecting to your party…';
  else if (wanted && !friend?.call) status = 'Waiting for your friend to join the call…';
  else if (wanted && peer?.pc.connectionState === 'connected') status = 'Call connected';
  else if (wanted && peer?.failed) status = 'Call connection failed';
  else if (wanted) status = 'Connecting call…';
  $('call-status').textContent = status;
  $('call-message').textContent = message;
  for (const kind of ['audio', 'video', 'output']) {
    $(`${kind}-device`).disabled = !devicesReady || mediaBusy || joining || outputBusy || (kind === 'output' && !hasOutputSelection);
  }
  $('choose-output').disabled = !devicesReady || outputBusy;
  $('quality').hidden = !wanted;
  if (peer?.pc.connectionState !== 'connected') showQuality('unknown', wanted ? 'Waiting for call connection' : '', '');
}
function showQuality(level, label, metrics) {
  $('quality').dataset.level = level;
  $('quality-label').textContent = label;
  $('quality-metrics').textContent = metrics;
}
async function sampleQuality(ctx) {
  if (peer !== ctx || ctx.sampling || ctx.pc.connectionState !== 'connected') return;
  ctx.sampling = true;
  try {
    const stats = await ctx.pc.getStats();
    if (peer !== ctx || ctx.pc.connectionState !== 'connected') return;
    let pair, rtt = null, jitter = null, loss = null, kbps = 0, measured = false;
    const next = new Map();
    stats.forEach(report => {
      if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    });
    stats.forEach(report => {
      if (!pair && report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
      if (!['inbound-rtp', 'outbound-rtp'].includes(report.type) || report.isRemote) return;
      next.set(report.id, report);
      const before = ctx.stats?.get(report.id);
      if (!before || report.timestamp <= before.timestamp) return;
      const received = report.type === 'inbound-rtp';
      const bytesKey = received ? 'bytesReceived' : 'bytesSent';
      const bytes = report[bytesKey] - before[bytesKey];
      if (Number.isFinite(bytes) && bytes >= 0) {
        measured = true;
        kbps += bytes * 8 / (report.timestamp - before.timestamp);
      }
      if (!received) return;
      const packets = report.packetsReceived - before.packetsReceived;
      const lost = report.packetsLost - before.packetsLost;
      // Counters may reset when tracks change; ignore that interval.
      if (packets >= 0 && Number.isFinite(lost) && packets + Math.max(0, lost) > 0) {
        loss = Math.max(loss ?? 0, 100 * Math.max(0, lost) / (packets + Math.max(0, lost)));
        if (Number.isFinite(report.jitter)) jitter = Math.max(jitter ?? 0, report.jitter * 1000);
      }
    });
    ctx.stats = next;
    if (Number.isFinite(pair?.currentRoundTripTime)) rtt = pair.currentRoundTripTime * 1000;
    const metrics = [];
    if (rtt !== null) metrics.push(`Round trip ${Math.round(rtt)} ms`);
    if (loss !== null) metrics.push(`Receive loss ${loss.toFixed(1)}%`);
    if (jitter !== null) metrics.push(`Jitter ${Math.round(jitter)} ms`);
    if (measured) metrics.push(`Send + receive ${Math.round(kbps)} kbps`);
    const hasMedia = live('audio') || live('video') || other()?.call?.mic || other()?.call?.camera;
    let level = 'unknown', label = 'Measuring call quality…';
    if (!hasMedia) label = 'Connected · microphones and cameras are off';
    else if (measured && kbps === 0) label = 'No media flowing';
    else if (rtt !== null || loss !== null || jitter !== null) {
      level = rtt > 500 || loss > 5 || jitter > 50 ? 'poor' : rtt > 250 || loss > 2 || jitter > 30 ? 'fair' : 'good';
      label = `${level[0].toUpperCase() + level.slice(1)} call connection · estimate`;
    }
    showQuality(level, label, metrics.join(' · '));
  } catch {
    if (peer === ctx) showQuality('unknown', 'Call quality unavailable', '');
  } finally { ctx.sampling = false; }
}
async function saveDevices() {
  await chrome.storage.local.set({ callDevices: { ...deviceChoices } });
}
async function refreshDevices() {
  const version = ++deviceRefresh;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (version !== deviceRefresh) return;
    for (const kind of ['audio', 'video', 'output']) {
      const select = $(`${kind}-device`);
      const options = [new Option('System default', '')];
      const available = devices.filter(device => device.kind === deviceKinds[kind] && device.deviceId);
      available.forEach((device, index) => options.push(new Option(device.label || `${deviceNames[kind]} ${index + 1}`, device.deviceId)));
      // An unlisted saved device may simply be hidden until permission is granted.
      if (deviceChoices[kind] && !available.some(device => device.deviceId === deviceChoices[kind])) {
        options.push(new Option('Saved device (currently unavailable)', deviceChoices[kind]));
      }
      select.replaceChildren(...options);
      select.value = deviceChoices[kind];
    }
  } catch { $('device-message').textContent = 'Could not list devices. System defaults are still available.'; }
}
async function selectDevice(kind, id) {
  if (!devicesReady || joining || mediaBusy || outputBusy) return;
  const version = generation;
  if (kind === 'output') outputBusy = true;
  else mediaBusy = true;
  $('device-message').textContent = ''; render();
  try {
    if (kind === 'output') await $('remote-video').setSinkId(id);
    else if (live(kind) && !await acquire(kind, id)) return;
    if (kind !== 'output' && version !== generation) return;
    deviceChoices[kind] = id;
    await saveDevices();
    $('device-message').textContent = `${deviceNames[kind]} selection saved.${kind !== 'output' && !live(kind) ? ' It will be used when you turn it on.' : ''}`;
    return true;
  } catch (error) {
    $('device-message').textContent = kind === 'output' ? `Could not switch speakers. ${error.message}` : permissionError(error, deviceNames[kind]);
    return false;
  } finally {
    if (kind === 'output') outputBusy = false;
    else if (version === generation) mediaBusy = false;
    await refreshDevices(); render();
  }
}
function closePeer() {
  const previous = peer;
  peer = null;
  if (previous) {
    clearTimeout(previous.deadline); clearTimeout(previous.retryTimer);
    clearInterval(previous.qualityTimer);
    previous.pc.close();
  }
  $('remote-video').srcObject = null;
  $('enable-audio').hidden = true;
}
function endCall(note = '') {
  const previous = session;
  generation++; wanted = false; joining = false; mediaBusy = false; registerPending = false;
  session = null; config = null; roomKey = ''; attempts = 0;
  closePeer();
  for (const track of localStream.getTracks()) { track.stop(); localStream.removeTrack(track); }
  tracks.audio = tracks.video = null;
  $('local-video').srcObject = null;
  message = note;
  if (previous) request({ type: 'CALL_STOP', session: previous }).catch(() => {});
  render();
}
async function acquire(kind, deviceId = deviceChoices[kind]) {
  const version = generation;
  const constraints = kind === 'audio'
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : { width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 24, max: 30 } };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: false, [kind]: constraints });
  if (version !== generation || (!wanted && !joining)) { stream.getTracks().forEach(t => t.stop()); return false; }
  const track = stream.getTracks()[0];
  try {
    const sender = peer?.senders[kind];
    await sender?.replaceTrack(track);
    if (version !== generation) { track.stop(); return false; }
    if (peer?.senders[kind] && peer.senders[kind] !== sender) await peer.senders[kind].replaceTrack(track);
    if (version !== generation) { track.stop(); return false; }
    if (track.readyState !== 'live') throw new Error('The selected device stopped before the switch completed.');
  } catch (error) {
    stream.getTracks().forEach(t => t.stop());
    if (version === generation) await peer?.senders[kind]?.replaceTrack(tracks[kind]).catch(() => {});
    throw error;
  }
  const previous = tracks[kind];
  tracks[kind] = track; localStream.addTrack(track);
  if (previous) { previous.stop(); localStream.removeTrack(previous); }
  $('local-video').srcObject = localStream;
  track.addEventListener('ended', () => {
    if (tracks[kind] !== track) return;
    tracks[kind] = null; localStream.removeTrack(track);
    peer?.senders[kind]?.replaceTrack(null).catch(() => {});
    message = `${deviceNames[kind]} disconnected or stopped. Select an available device and turn it on again.`;
    refreshDevices();
    mediaChanged(); render();
  });
  refreshDevices();
  return true;
}
function permissionError(error, kind) {
  if (['NotAllowedError', 'SecurityError'].includes(error.name)) return `${kind} access was denied. Allow it for this extension in Chrome, then try again.`;
  if (error.name === 'NotFoundError') return `No ${kind.toLowerCase()} was found. Connect a device and try again.`;
  if (error.name === 'NotReadableError') return `Chrome could not use your ${kind.toLowerCase()}. Check whether another app is using it.`;
  if (error.name === 'OverconstrainedError') return `The selected ${kind.toLowerCase()} is unavailable. Choose System default or another device.`;
  return `Could not enable ${kind.toLowerCase()}. ${error.message || ''}`;
}
async function join(withMic) {
  if (!devicesReady || wanted || joining || view?.status !== 'connected') return;
  const version = generation;
  joining = true; roomKey = currentKey(); message = ''; render();
  try {
    if (withMic && !await acquire('audio')) return;
    if (!joining) return;
    wanted = true; joining = false;
    await register();
  } catch (error) { if (version === generation) endCall(permissionError(error, 'Microphone')); }
  render();
}
async function toggle(kind) {
  if (!wanted || mediaBusy) return;
  const version = generation;
  mediaBusy = true; message = ''; render();
  try {
    if (live(kind)) {
      const track = tracks[kind]; tracks[kind] = null;
      track.stop(); localStream.removeTrack(track);
      await peer?.senders[kind]?.replaceTrack(null);
    } else await acquire(kind);
    if (version === generation) mediaChanged();
  } catch (error) { if (version === generation) message = permissionError(error, kind === 'audio' ? 'Microphone' : 'Camera'); }
  if (version === generation) mediaBusy = false;
  render();
}
function mediaChanged() {
  if (session && view?.status === 'connected') request({ type: 'CALL_MEDIA', session, mic: live('audio'), camera: live('video') }).catch(error => { message = error.message; render(); });
}
async function register() {
  if (!wanted || joining || registerPending || view?.status !== 'connected') return;
  registerPending = true; config = null; closePeer();
  const next = crypto.randomUUID(); session = next;
  try {
    await request({ type: 'CALL_READY', code: view.party.code, session: next, mic: live('audio'), camera: live('video') });
  } catch (error) { if (session === next) { session = null; message = error.message; } }
  finally { registerPending = false; render(); }
}
function sendSignal(ctx, data) {
  if (peer !== ctx || !wanted || session !== ctx.session) return Promise.resolve();
  return request({ type: 'CALL_SIGNAL', session, to: ctx.other.id, peerSession: ctx.other.call.session, data });
}
function failed(ctx) {
  if (peer !== ctx) return;
  ctx.failed = true;
  message = 'Could not connect on this network. Reconnect the call, or ask the host to configure call relay support.';
  render();
  if (attempts++ < 1) ctx.retryTimer = setTimeout(() => { if (peer === ctx) register(); }, 1500);
}
async function makePeer(friend) {
  const pc = new RTCPeerConnection(config);
  const ctx = { pc, session, other: friend, candidates: [], senders: {}, failed: false, chain: Promise.resolve() };
  peer = ctx;
  showQuality('unknown', 'Measuring call quality…', '');
  ctx.qualityTimer = setInterval(() => sampleQuality(ctx), 2000);
  // Fixed audio/video transceivers avoid renegotiation when mic/camera are toggled.
  // Only the lower participant ID creates offers, so simultaneous joins cannot collide.
  const caller = view.meId < friend.id;
  if (caller) for (const kind of ['audio', 'video']) ctx.senders[kind] = pc.addTransceiver(kind, { direction: 'sendrecv', streams: [localStream] }).sender;
  ctx.ready = caller ? Promise.all(['audio', 'video'].map(kind => ctx.senders[kind].replaceTrack(tracks[kind]))) : Promise.resolve();
  pc.onicecandidate = event => { if (event.candidate) sendSignal(ctx, { candidate: event.candidate.toJSON() }).catch(() => {}); };
  const remoteStream = new MediaStream();
  pc.ontrack = event => {
    if (peer !== ctx) return;
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
    $('remote-video').srcObject = remoteStream;
    $('remote-video').muted = speakersMuted;
    $('remote-video').play().catch(() => { if (peer === ctx) $('enable-audio').hidden = false; });
  };
  pc.onconnectionstatechange = () => {
    if (peer !== ctx) return;
    if (pc.connectionState === 'connected') { clearTimeout(ctx.deadline); clearTimeout(ctx.retryTimer); message = ''; ctx.failed = false; }
    if (pc.connectionState === 'failed') failed(ctx);
    if (pc.connectionState === 'disconnected') {
      clearTimeout(ctx.retryTimer);
      ctx.retryTimer = setTimeout(() => { if (peer === ctx && pc.connectionState === 'disconnected') failed(ctx); }, 6000);
    }
    render();
  };
  ctx.deadline = setTimeout(() => { if (peer === ctx && pc.connectionState !== 'connected') failed(ctx); }, 25_000);
  await ctx.ready;
  if (peer !== ctx) return;
  if (view.meId < friend.id) {
    await pc.setLocalDescription(await pc.createOffer());
    await sendSignal(ctx, { description: pc.localDescription.toJSON() });
  }
}
function maybePeer() {
  const friend = other();
  if (!wanted || !config || !session || view?.status !== 'connected') return;
  if (!friend?.online || !friend.call) { closePeer(); render(); return; }
  if (view.room.participants.find(p => p.id === view.meId)?.call?.session !== session) return;
  if (peer?.other.id === friend.id && peer.other.call.session === friend.call.session && peer.session === session) return;
  closePeer();
  makePeer(friend).catch(error => { message = `Call setup failed. ${error.message}`; render(); });
}
function receive(packet) {
  if (!wanted || !session) return;
  if (packet.type === 'call-config' && packet.session === session) {
    config = { iceServers: packet.iceServers, iceTransportPolicy: packet.iceTransportPolicy };
    maybePeer(); return;
  }
  if (packet.type !== 'signal' || packet.peerSession !== session) return;
  maybePeer();
  const ctx = peer;
  if (!ctx || packet.from !== ctx.other.id || packet.session !== ctx.other.call.session) return;
  ctx.chain = ctx.chain.then(async () => {
    await ctx.ready;
    if (peer !== ctx) return;
    const { description, candidate } = packet.data;
    if (description) {
      if (description.type === 'offer' && view.meId < ctx.other.id) return;
      await ctx.pc.setRemoteDescription(description);
      for (const queued of ctx.candidates.splice(0)) await ctx.pc.addIceCandidate(queued);
      if (description.type === 'offer') {
        // Reuse the transceivers created by the remote offer. Pre-creating them
        // on the answerer can produce extra, unnegotiated senders.
        for (const transceiver of ctx.pc.getTransceivers()) {
          const kind = transceiver.receiver.track.kind;
          transceiver.direction = 'sendrecv';
          transceiver.sender.setStreams(localStream);
          ctx.senders[kind] = transceiver.sender;
          await transceiver.sender.replaceTrack(tracks[kind]);
        }
        await ctx.pc.setLocalDescription(await ctx.pc.createAnswer());
        await sendSignal(ctx, { description: ctx.pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      if (ctx.pc.remoteDescription) await ctx.pc.addIceCandidate(candidate);
      else ctx.candidates.push(candidate);
    }
  }).catch(error => { if (peer === ctx) { message = `Call setup interrupted. Reconnect the call. ${error.message}`; render(); } });
}
function update(next) {
  view = next;
  if ((wanted || joining) && (roomKey !== currentKey() || ['error', 'removed', 'idle'].includes(view?.status))) {
    endCall(view?.error || 'Your party changed. Join again when you are ready.'); return;
  }
  if (wanted) {
    if (view.status !== 'connected') { session = null; config = null; closePeer(); }
    else if (!session) register();
    else maybePeer();
  }
  render();
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.roomView) update(changes.roomView.newValue); });
function attachPort() {
  try { port = chrome.runtime.connect({ name: 'call-window' }); }
  catch { endCall('The extension was updated. Reopen the call window to continue.'); return; }
  port.onMessage.addListener(message => { if (message.type === 'CALL_PACKET') receive(message.packet); });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    endCall('Call connection reset. Join again when the party reconnects.');
    setTimeout(attachPort, 1000);
  });
}
attachPort();
$('join-voice').onclick = () => join(true);
$('listen').onclick = () => join(false);
$('mic').onclick = () => toggle('audio');
$('camera').onclick = () => toggle('video');
$('speaker').onclick = () => { speakersMuted = !speakersMuted; $('remote-video').muted = speakersMuted; render(); };
$('hangup').onclick = () => endCall('You left the call. The watch party continues.');
$('retry-call').onclick = () => { attempts = 0; message = ''; register(); };
$('enable-audio').onclick = async () => { try { await $('remote-video').play(); $('enable-audio').hidden = true; } catch { message = 'Chrome could not play audio. Check your sound settings.'; render(); } };
for (const kind of ['audio', 'video', 'output']) {
  $(`${kind}-device`).onchange = event => selectDevice(kind, event.target.value);
}
$('choose-output').hidden = !hasOutputSelection || typeof navigator.mediaDevices.selectAudioOutput !== 'function';
$('choose-output').onclick = async () => {
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    await selectDevice('output', device.deviceId);
  } catch (error) { $('device-message').textContent = `Speaker selection cancelled or unavailable. ${error.message}`; }
};
navigator.mediaDevices.addEventListener('devicechange', async () => {
  await refreshDevices();
  if (!hasOutputSelection || !deviceChoices.output || outputBusy || !devicesReady) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(device => device.kind === 'audiooutput' && device.deviceId === deviceChoices.output)) return;
    if (await selectDevice('output', '')) $('device-message').textContent = 'Selected speakers became unavailable. Using system default.';
  } catch { $('device-message').textContent = 'Check your speaker selection; the device list changed.'; }
});
async function initDevices() {
  try {
    const { callDevices } = await chrome.storage.local.get('callDevices');
    for (const kind of ['audio', 'video', 'output']) {
      if (typeof callDevices?.[kind] === 'string') deviceChoices[kind] = callDevices[kind];
    }
    if (hasOutputSelection && deviceChoices.output) {
      try { await $('remote-video').setSinkId(deviceChoices.output); }
      catch {
        deviceChoices.output = '';
        await saveDevices();
        $('device-message').textContent = 'Saved speakers are unavailable. Using system default; choose speakers again if needed.';
      }
    }
    if (!hasOutputSelection) $('device-help').textContent = 'Speaker selection is unavailable in this browser. Use your system sound settings. Input names appear after you allow access.';
    await refreshDevices();
  } catch { $('device-message').textContent = 'Could not restore device preferences. Choose your devices below.'; }
  finally { devicesReady = true; render(); }
}
window.addEventListener('pagehide', () => endCall());
initDevices();
request({ type: 'GET_VIEW' }).then(update).catch(error => { message = error.message; render(); });
