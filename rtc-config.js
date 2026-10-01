// Configuration supplied to callers only after joining an authenticated room socket.
function readIceConfig(env = process.env) {
  const servers = JSON.parse(env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
  if (!Array.isArray(servers) || servers.length > 8) throw new Error('ICE_SERVERS must be an array with at most 8 entries.');
  for (const server of servers) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw new Error('Invalid ICE server URL.');
    if (server.username !== undefined && typeof server.username !== 'string') throw new Error('Invalid ICE username.');
    if (server.credential !== undefined && typeof server.credential !== 'string') throw new Error('Invalid ICE credential.');
  }
  const policy = env.ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(policy)) throw new Error('ICE_TRANSPORT_POLICY must be all or relay.');
  if (policy === 'relay' && !servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(url => /^turns?:/.test(url)))) throw new Error('Relay-only calls require a TURN server in ICE_SERVERS.');
  return { iceServers: servers, iceTransportPolicy: policy };
}
module.exports = { readIceConfig };
