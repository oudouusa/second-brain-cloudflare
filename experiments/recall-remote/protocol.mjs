export function stagingEndpoint(endpoint) {
  const url = new URL(endpoint);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (local ? !['http:', 'https:'].includes(url.protocol)
      : url.protocol !== 'https:' || url.port
        || !/^sb54-(baseline|candidate)-20260907\.staging-example\.workers\.dev$/.test(url.hostname))) {
    throw new Error('Only localhost or the two dedicated staging endpoints are allowed');
  }
  return url;
}

export function rpcReply(raw, id) {
  const messages = raw.trimStart().startsWith('{') ? [JSON.parse(raw)]
    : raw.split(/\r?\n\r?\n/).filter(block => /^data:/m.test(block)).map(block =>
      JSON.parse(block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')));
  const replies = messages.filter(message => message.id === id);
  if (replies.length !== 1) throw new Error('Missing or duplicate MCP reply');
  return replies[0];
}
