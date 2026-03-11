chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COMMENTS_COLLECTED") {
    fetch("http://localhost:3000/api/ingest/comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
        // TODO: 携带鉴权 token
      },
      body: JSON.stringify(message.payload)
    }).then(() => {
      console.log("Comments sent to backend")
    }).catch((err) => {
      console.error("Failed to send comments", err)
    })
  }
})
