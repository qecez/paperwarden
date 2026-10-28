import { cameraScanner } from "./app/camera";
import { runCrypto } from "./crypto/client";
import { friendly, PaperError } from "./crypto/errors";
import { fingerprint } from "./crypto/primitives";
import { formatBackupId } from "./encoding/backup-id";
import {
  ARCHIVE_LABEL,
  MAX_ARCHIVE_CHARACTERS,
  decodeArchive,
} from "./encoding/archive";
import { qrSvg, scanFile } from "./encoding/qr";
import { decodeLinkFragment, decodeQrPayload } from "./encoding/link";
import { encodeTransport } from "./encoding/transport";
import { MAX_MESSAGES, maximumTextBytes } from "./format/constants";
import { parseEnvelope } from "./format/envelope";
import { preparePrint } from "./print/backup";
import { download } from "./recovery/download";

// Capture only the pristine release. Never serialize a document after interaction.
// The build canonicalizes HTML so this is also a byte-identical downloadable reader.
const originalRelease = "<!DOCTYPE html>" + document.documentElement.outerHTML;
// Consume a recovery link before populating the UI. Never navigate to or fetch
// its host, and never put encrypted data in history state or persistent storage.
function takeRecoveryFragment(): string | null {
  const fragment = location.hash;
  if (!fragment || fragment === "#main") return null;
  try {
    history.replaceState(null, "", location.href.split("#", 1)[0]);
  } catch {
    // Some local-file browsers restrict history rewriting. Recovery is still
    // local; URL cleanup cannot erase copies retained by the browser or scanner.
  }
  return fragment;
}
const initialFragment = takeRecoveryFragment();
const utf8 = new TextEncoder();
const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing application element: ${id}`);
  return found as T;
};
const field = (id: string) => element<HTMLInputElement>(id);
const area = (id: string) => element<HTMLTextAreaElement>(id);
const show = (id: string, visible: boolean) => {
  element(id).hidden = !visible;
};
const report = (id: string, text = "") => {
  element(id).textContent = text;
  show(id, text.length > 0);
};
const messageFields = () =>
  Array.from(document.querySelectorAll<HTMLFieldSetElement>("[data-message]"));
const textIn = (group: HTMLElement) =>
  group.querySelector<HTMLTextAreaElement>("[data-text]")!;
const passwordIn = (group: HTMLElement) =>
  group.querySelector<HTMLInputElement>("[data-password]")!;

type Operation = { id: number; controller: AbortController };
type Disableable =
  | HTMLButtonElement
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLFieldSetElement;
let revision = 0;
let operation: Operation | undefined;
let generated: Uint8Array | undefined;
let loaded: Uint8Array | undefined;
let stale = false;
let nextMessageId = 1;
const disabled = new Map<Disableable, boolean>();

function setBusy(value: boolean, label = "") {
  if (value) {
    for (const control of document.querySelectorAll<Disableable>(
      "#encrypt-fields, #encrypt-button, #decrypt-fields, [data-import], [data-export], #photo, #encoded",
    )) {
      disabled.set(control, control.disabled);
      control.disabled = true;
    }
  } else {
    for (const [control, previous] of disabled) control.disabled = previous;
    disabled.clear();
    for (const control of document.querySelectorAll<HTMLButtonElement>(
      "[data-export]",
    ))
      control.disabled = !generated || stale;
  }
  element("main").setAttribute("aria-busy", String(value));
  report("busy-status", label);
}
function cancelOperation() {
  revision++;
  operation?.controller.abort();
  operation = undefined;
  setBusy(false);
}
function beginOperation(label: string): Operation {
  cancelOperation();
  operation = { id: revision, controller: new AbortController() };
  setBusy(true, label);
  return operation;
}
const isCurrent = (job: Operation) =>
  operation === job && !job.controller.signal.aborted;
function finishOperation(job: Operation) {
  if (!isCurrent(job)) return;
  operation = undefined;
  setBusy(false);
}
function resetPasswordButtons(root: ParentNode = document) {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-show]",
  )) {
    field(button.dataset.show!).type = "password";
    button.textContent = "Show password";
    button.setAttribute("aria-pressed", "false");
  }
}
function clearRecovered() {
  element("recovered-text").textContent = "";
  field("open-password").value = "";
  show("recovered", false);
  resetPasswordButtons(element("decrypt-view"));
}
function discardGenerated() {
  generated?.fill(0);
  generated = undefined;
  stale = false;
  show("backup-result", false);
  element<HTMLImageElement>("qr").removeAttribute("src");
  element("backup-id").textContent = "";
  element("print-root").replaceChildren();
  report("print-help");
}
function clearRecovery() {
  cancelOperation();
  stopCamera();
  loaded?.fill(0);
  loaded = undefined;
  clearRecovered();
  area("encoded").value = "";
  field("photo").value = "";
  show("decrypt-form", false);
  show("paste-form", false);
  show("input-methods", true);
  report("load-message");
  report("loaded-backup-id");
  report("decrypt-error");
}
const camera = cameraScanner(
  element<HTMLVideoElement>("video"),
  (bytes) => {
    void importBackup(() => bytes);
  },
  (text) => {
    show("camera", false);
    report("decrypt-error", text);
  },
);
function stopCamera() {
  camera.stop();
  show("camera", false);
}
function chooseView(mode: "encrypt" | "decrypt", focus = true) {
  cancelOperation();
  stopCamera();
  clearRecovered();
  show("encrypt-view", mode === "encrypt");
  show("decrypt-view", mode === "decrypt");
  show("decrypt-form", !!loaded);
  for (const name of ["encrypt", "decrypt"] as const) {
    if (name === mode)
      element(`${name}-tab`).setAttribute("aria-current", "page");
    else element(`${name}-tab`).removeAttribute("aria-current");
  }
  if (focus) element(mode === "encrypt" ? "text" : "decrypt-heading").focus();
}

function updateCapacity() {
  const groups = messageFields();
  const used = groups.reduce(
    (sum, group) => sum + utf8.encode(textIn(group).value).length,
    0,
  );
  const maximum = maximumTextBytes(groups.length);
  const percent = Math.floor((used / maximum) * 100);
  const status =
    used > maximum
      ? "Over capacity — shorten your text"
      : used === maximum
        ? "Full"
        : used > 0 && percent === 0
          ? "Less than 1% used"
          : `${percent}% used`;
  for (const group of groups) {
    const capacity = group.querySelector<HTMLElement>("[data-capacity]")!;
    capacity.querySelector<HTMLElement>("[data-capacity-label]")!.textContent =
      groups.length > 1 ? "Shared backup space" : "Backup space";
    capacity.querySelector<HTMLElement>("[data-capacity-status]")!.textContent =
      status;
    const meter = capacity.querySelector<HTMLMeterElement>(
      "[data-capacity-meter]",
    )!;
    meter.max = maximum;
    meter.value = Math.min(used, maximum);
    meter.setAttribute("aria-valuetext", status);
    capacity.classList.toggle("over-capacity", used > maximum);
  }
  element<HTMLButtonElement>("add-message").disabled =
    groups.length >= MAX_MESSAGES;
  show("message-limit", groups.length >= MAX_MESSAGES);
}
function changed() {
  cancelOperation();
  if (generated) {
    stale = true;
    show("stale", true);
    element("print-root").replaceChildren();
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-export]",
    ))
      button.disabled = true;
  }
  report("encrypt-error");
  updateCapacity();
}
function addMessage() {
  if (messageFields().length >= MAX_MESSAGES || operation) return;
  const suffix = ++nextMessageId;
  const group = document.createElement("fieldset");
  group.className = "message-fields additional-message";
  group.dataset.message = "";
  const legend = document.createElement("legend");
  legend.textContent = "Another message";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet remove-message";
  remove.textContent = "Remove message";
  remove.addEventListener("click", () => {
    textIn(group).value = "";
    passwordIn(group).value = "";
    group.remove();
    changed();
    element("add-message").focus();
  });
  const textLabel = document.createElement("label");
  textLabel.htmlFor = `message-text-${suffix}`;
  textLabel.textContent = "Message";
  const text = document.createElement("textarea");
  text.id = textLabel.htmlFor;
  text.dataset.text = "";
  text.rows = 3;
  text.required = true;
  text.spellcheck = false;
  text.autocomplete = "off";
  // Every message shows the same shared budget, with its own accessible labels.
  const capacity = element("capacity-display").cloneNode(true) as HTMLElement;
  capacity.id = `capacity-display-${suffix}`;
  const capacityLabel = capacity.querySelector<HTMLLabelElement>(
    "[data-capacity-label]",
  )!;
  const capacityStatus = capacity.querySelector<HTMLElement>(
    "[data-capacity-status]",
  )!;
  const capacityMeter = capacity.querySelector<HTMLMeterElement>(
    "[data-capacity-meter]",
  )!;
  capacityLabel.id = `capacity-label-${suffix}`;
  capacityStatus.id = `capacity-status-${suffix}`;
  capacityMeter.id = `capacity-meter-${suffix}`;
  capacityLabel.htmlFor = capacityMeter.id;
  // Keep one live announcement for the shared total, rather than repeating it.
  capacityStatus.removeAttribute("aria-live");
  capacityStatus.removeAttribute("aria-atomic");
  text.setAttribute(
    "aria-describedby",
    `${capacityLabel.id} ${capacityStatus.id}`,
  );
  const passwordLabel = document.createElement("label");
  passwordLabel.htmlFor = `message-password-${suffix}`;
  passwordLabel.textContent = "Different password";
  const passwordRow = document.createElement("div");
  passwordRow.className = "password-row";
  const password = document.createElement("input");
  password.id = passwordLabel.htmlFor;
  password.dataset.password = "";
  password.type = "password";
  password.autocomplete = "off";
  password.setAttribute("autocorrect", "off");
  password.autocapitalize = "none";
  password.spellcheck = false;
  password.required = true;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "quiet";
  toggle.dataset.show = password.id;
  toggle.setAttribute("aria-controls", password.id);
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = "Show password";
  passwordRow.append(password, toggle);
  group.append(
    legend,
    remove,
    textLabel,
    text,
    capacity,
    passwordLabel,
    passwordRow,
  );
  element("message-list").append(group);
  changed();
  text.focus();
}

function setLoaded(bytes: Uint8Array, digest: string) {
  stopCamera();
  loaded?.fill(0);
  loaded = new Uint8Array(bytes);
  clearRecovered();
  show("paste-form", false);
  show("decrypt-form", true);
  report("decrypt-error");
  report("load-message", "Backup loaded. Enter your password to open it.");
  report("loaded-backup-id", `Backup ID: ${formatBackupId(digest)}`);
  field("open-password").focus();
}
async function importBackup(read: () => Promise<Uint8Array> | Uint8Array) {
  stopCamera();
  clearRecovered();
  loaded?.fill(0);
  loaded = undefined;
  show("decrypt-form", false);
  report("load-message");
  report("loaded-backup-id");
  report("decrypt-error");
  const job = beginOperation("Reading your backup…");
  try {
    const bytes = await read();
    if (!isCurrent(job)) return;
    parseEnvelope(bytes);
    const digest = await fingerprint(bytes);
    if (!isCurrent(job)) return;
    // Publish the validated backup and its ID together. A cancelled or replaced
    // import must never put an older ID beside a newer backup's password field.
    setLoaded(bytes, digest);
  } catch (error) {
    if (isCurrent(job)) report("decrypt-error", friendly(error));
  } finally {
    finishOperation(job);
    if (loaded && revision === job.id) field("open-password").focus();
  }
}
async function readEncryptedText(text: string): Promise<Uint8Array> {
  if (text.length > MAX_ARCHIVE_CHARACTERS) throw new PaperError("format");
  // Only inspect the heading. Raw-text spaces remain untouched. A linked QR is
  // decoded locally; its address is data, never a navigation or network request.
  if (text.trimStart().startsWith(ARCHIVE_LABEL)) return decodeArchive(text);
  return decodeQrPayload(text);
}

function validInputs(id: string): boolean {
  for (const input of element(id).querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input, textarea")) {
    if (!input.reportValidity()) return false;
  }
  return true;
}

// These are local cryptographic operations, not account sign-in forms. Keep
// native secure inputs and validation without submitting credentials. Browsers
// and extensions can still override the fields' autocomplete preference.
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Enter" ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (!input.matches("[data-password], #open-password")) return;
  event.preventDefault();
  element<HTMLButtonElement>(
    input.id === "open-password" ? "open-button" : "encrypt-button",
  ).click();
});

// Delegation also covers dynamically added password controls.
document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-show]",
  );
  if (!button || button.disabled) return;
  const input = field(button.dataset.show!);
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "Hide password" : "Show password";
  button.setAttribute("aria-pressed", String(visible));
});
element("encrypt-tab").addEventListener("click", () => chooseView("encrypt"));
element("decrypt-tab").addEventListener("click", () => chooseView("decrypt"));
element("add-message").addEventListener("click", addMessage);
element("encrypt-form").addEventListener("input", changed);
element("encrypt-button").addEventListener("click", async () => {
  if (operation || !validInputs("encrypt-form")) return;
  report("encrypt-error");
  const messages = messageFields().map((group) => ({
    text: textIn(group).value,
    password: passwordIn(group).value,
  }));
  const job = beginOperation("Creating your backup…");
  try {
    const bytes = await runCrypto<Uint8Array>(
      { kind: "encrypt", messages },
      { signal: job.controller.signal },
    );
    if (!isCurrent(job)) return;
    const svg = qrSvg(bytes);
    const digest = await fingerprint(bytes);
    if (!isCurrent(job)) return;
    await preparePrint(bytes, { signal: job.controller.signal });
    if (!isCurrent(job)) return;
    generated?.fill(0);
    generated = bytes;
    stale = false;
    element<HTMLImageElement>("qr").src =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    element("backup-id").textContent = `Backup ID: ${formatBackupId(digest)}`;
    show("stale", false);
    show("backup-result", true);
    report("print-help");
    element("backup-heading").focus();
  } catch (error) {
    if (isCurrent(job)) report("encrypt-error", friendly(error));
  } finally {
    for (const message of messages) message.text = message.password = "";
    finishOperation(job);
  }
});
element("clear-create").addEventListener("click", () => {
  cancelOperation();
  for (const group of messageFields()) {
    textIn(group).value = "";
    passwordIn(group).value = "";
    if (group.classList.contains("additional-message")) group.remove();
  }
  discardGenerated();
  resetPasswordButtons(element("encrypt-view"));
  report("encrypt-error");
  updateCapacity();
  area("text").focus();
});

function printBackup() {
  if (!generated || stale || operation) return;
  report(
    "print-help",
    "Print at 100% on A4 or US Letter and keep the full white border.",
  );
  window.print();
}
element("print").addEventListener("click", printBackup);
element("save-text").addEventListener("click", () => {
  if (generated && !stale && !operation)
    download(
      encodeTransport(generated),
      "text/plain;charset=utf-8",
      "paperwarden-backup.txt",
    );
});
element("scan").addEventListener("click", () => {
  if (operation) return;
  report("decrypt-error");
  show("camera", true);
  void camera.start();
});
element("stop-camera").addEventListener("click", stopCamera);
element("choose-photo").addEventListener("click", () => {
  stopCamera();
  field("photo").click();
});
field("photo").addEventListener("change", () => {
  const file = field("photo").files?.[0];
  field("photo").value = "";
  if (file) void importBackup(() => scanFile(file));
});
element("paste").addEventListener("click", () => {
  stopCamera();
  show("paste-form", true);
  area("encoded").focus();
});
element("paste-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!operation)
    void importBackup(() => readEncryptedText(area("encoded").value));
});
element("open-button").addEventListener("click", async () => {
  if (operation || !loaded || !validInputs("decrypt-form")) return;
  report("decrypt-error");
  clearRecoveredTextOnly();
  const job = beginOperation("Opening your backup…");
  try {
    const result = await runCrypto<{ text: string }>(
      {
        kind: "decrypt",
        container: loaded,
        password: field("open-password").value,
      },
      { signal: job.controller.signal },
    );
    if (!isCurrent(job)) return;
    element("recovered-text").textContent = result.text;
    result.text = "";
    field("open-password").value = "";
    resetPasswordButtons(element("decrypt-view"));
    show("decrypt-form", false);
    show("recovered", true);
    element("recovered-heading").focus();
  } catch (error) {
    if (isCurrent(job)) report("decrypt-error", friendly(error));
  } finally {
    finishOperation(job);
  }
});
function clearRecoveredTextOnly() {
  element("recovered-text").textContent = "";
  show("recovered", false);
}
element("close-text").addEventListener("click", () => {
  clearRecovered();
  show("decrypt-form", !!loaded);
  field("open-password").focus();
});

const about = element<HTMLDialogElement>("about-dialog");
element("about").addEventListener("click", () => {
  stopCamera();
  about.showModal();
});
element("close-about").addEventListener("click", () => about.close());
element("save-reader").addEventListener("click", () =>
  download(originalRelease, "text/html;charset=utf-8", "paperwarden.html"),
);
if (element<HTMLScriptElement>("application").src) {
  element<HTMLButtonElement>("save-reader").disabled = true;
  element("save-reader").title =
    "Build the standalone app to download an offline copy.";
}

window.addEventListener("pagehide", () => {
  cancelOperation();
  stopCamera();
  clearRecovery();
  discardGenerated();
  for (const input of document.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input[data-password], #open-password, textarea"))
    input.value = "";
  resetPasswordButtons();
});
function loadRecoveryFragment(fragment: string) {
  clearRecovery();
  chooseView("decrypt", false);
  // All entry points use the same cancellable import and ID calculation.
  void importBackup(() => decodeLinkFragment(fragment));
}
window.addEventListener("hashchange", () => {
  const fragment = takeRecoveryFragment();
  if (fragment !== null) loadRecoveryFragment(fragment);
  else if (!location.hash) {
    // Returning to a consumed link must not keep an unrelated recovered secret.
    clearRecovery();
    chooseView("decrypt", false);
  }
});
updateCapacity();
chooseView(location.protocol === "file:" ? "decrypt" : "encrypt", false);
if (initialFragment !== null) {
  loadRecoveryFragment(initialFragment);
}
