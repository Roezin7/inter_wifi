function pickInboundMedia(inboundMedia) {
  const urls = Array.isArray(inboundMedia?.urls) ? inboundMedia.urls : [];
  const items = Array.isArray(inboundMedia?.items) ? inboundMedia.items : [];
  const first = items[0] || null;

  return {
    url: first?.url || urls[0] || null,
    id: first?.id || inboundMedia?.id || null,
    mimetype: first?.mimetype || inboundMedia?.mimetype || null,
    mediaKey: first?.mediaKey || null,
    fileName: first?.fileName || null,
    type: first?.type || null,
  };
}

module.exports = { pickInboundMedia };
