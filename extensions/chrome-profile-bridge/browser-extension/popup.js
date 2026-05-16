// Popup UI for pi-chrome pairing.
//
// Talks to the service worker via chrome.runtime.sendMessage. The service worker performs the
// HTTP /pair handshake against the local Pi bridge and stores the resulting HMAC keys in
// chrome.storage.local. This popup never sees raw keys; it only sees pair success/failure and
// the paired bridgeId.

const $ = (id) => document.getElementById(id);

async function refresh() {
  const reply = await chrome.runtime.sendMessage({ type: "pi-chrome-status" });
  if (!reply?.ok) return;
  $("status").textContent = "";
  if (reply.paired) {
    $("paired-info").hidden = false;
    $("pair-form").hidden = true;
    $("ext-id").textContent = reply.extensionId;
    $("bridge-id").textContent = reply.bridgeId;
  } else {
    $("paired-info").hidden = true;
    $("pair-form").hidden = false;
  }
}

$("pair-btn").addEventListener("click", async () => {
  const invite = $("invite").value.trim();
  if (!invite) return;
  $("result").className = "row muted";
  $("result").textContent = "Pairing…";
  const reply = await chrome.runtime.sendMessage({ type: "pi-chrome-pair", invite });
  if (reply?.ok) {
    $("result").className = "row ok";
    $("result").textContent = `Paired with bridge ${reply.info.bridgeId}.`;
    setTimeout(refresh, 500);
  } else {
    $("result").className = "row err";
    $("result").textContent = reply?.error ?? "Pairing failed.";
  }
});

$("unpair-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "pi-chrome-unpair" });
  await refresh();
});

refresh();
