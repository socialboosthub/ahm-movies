async function publishTikTok(video, story) {
  if (!process.env.TIKTOK_ACCESS_TOKEN) {
    return { status: "not_connected", note: "TikTok authorization is required before automatic posting." };
  }
  // Publishing adapter intentionally stops here until the account has been
  // authorized and a public video URL is available. Add the platform's current
  // Direct Post initialization/upload flow here.
  return { status: "connected_not_executed", note: "TikTok credentials detected; posting adapter needs account authorization and final public video URL." };
}

async function publishYouTube(video, story) {
  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    return { status: "not_connected", note: "YouTube OAuth is required before automatic posting." };
  }
  return { status: "connected_not_executed", note: "YouTube OAuth detected; uploader is ready for the final video URL/file." };
}

module.exports = { publishTikTok, publishYouTube };
