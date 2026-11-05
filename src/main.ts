import { setupDonations } from "./app/donations";
import { cameraScanner } from "./app/camera";
import { generatePassphrase } from "./app/passphrase";
import {
  generatePasswordControl,
  showPasswordControl,
} from "./app/password-controls";
import { runCrypto } from "./crypto/client";
import { friendly, PaperError } from "./crypto/errors";
import { fingerprint } from "./crypto/primitives";
import { formatShortBackupId } from "./encoding/backup-id";
import {
  ARCHIVE_LABEL,
  ARCHIVE_BEGIN,
  MAX_ARCHIVE_CHARACTERS,
  decodeArchive,
} from "./encoding/archive";
import { qrSvg, scanFile } from "./encoding/qr";
import { decodeLinkFragment, decodeQrPayload } from "./encoding/link";
import { MAX_MESSAGES, maximumTextBytes } from "./format/constants";
import { parseEnvelope } from "./format/envelope";
import { preparePrint, type PreparedBackup } from "./print/backup";
import { download } from "./recovery/download";

// Capture only the pristine release. Never serialize a document after interaction.
// The build canonicalizes HTML so this is also a byte-identical downloadable reader.
const originalRelease = "<!DOCTYPE html>" + document.documentElement.outerHTML;
// Dialog autofocus can inherit a keyboard ring after a tap. Track actual
// pointer use, and restore a visible focus cue when navigating with keys.
document.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.pointerFocus = "";
  },
  { capture: true, passive: true },
);
document.addEventListener(
  "keydown",
  (event) => {
    if (
      [
        "Tab",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Escape",
      ].includes(event.key)
    )
      delete document.documentElement.dataset.pointerFocus;
  },
  true,
);
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
function backupLabel(digest?: string) {
  const target = element("loaded-backup-id");
  target.replaceChildren();
  show("loaded-backup-id", !!digest);
  if (!digest) return;
  const words = document.createElement("em");
  words.textContent = formatShortBackupId(digest);
  target.append("Backup ", words, " loaded.");
}
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
  | HTMLSelectElement
  | HTMLFieldSetElement;
let revision = 0;
let operation: Operation | undefined;
let textImportTimer: number | undefined;
let photoSelectionRevision: number | undefined;
let generated: PreparedBackup | undefined;
let loaded: Uint8Array | undefined;
let nextMessageId = 1;
const disabled = new Map<Disableable, boolean>();

function setBusy(value: boolean, label = "", importsEditable = false) {
  if (value) {
    for (const control of document.querySelectorAll<Disableable>(
      "#encrypt-fields, #encrypt-button, #add-message, #remove-message, #decrypt-fields, [data-import], [data-export], #photo, #encoded",
    )) {
      // Import validation can be replaced by an edit, scan, or another image.
      if (importsEditable && control.matches("[data-import], #photo, #encoded"))
        continue;
      disabled.set(control, control.disabled);
      control.disabled = true;
    }
  } else {
    for (const [control, previous] of disabled) control.disabled = previous;
    disabled.clear();
    for (const control of document.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement
    >("[data-export]"))
      control.disabled = !generated;
  }
  element("main").setAttribute("aria-busy", String(value));
  report("busy-status", label);
}
function cancelOperation() {
  window.clearTimeout(textImportTimer);
  textImportTimer = undefined;
  photoSelectionRevision = undefined;
  revision++;
  operation?.controller.abort();
  operation = undefined;
  setBusy(false);
}
function beginOperation(label: string, importsEditable = false): Operation {
  cancelOperation();
  operation = { id: revision, controller: new AbortController() };
  setBusy(true, label, importsEditable);
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
    showPasswordControl(button, false);
  }
  for (const status of root.querySelectorAll<HTMLElement>(
    "[data-password-status]",
  )) {
    status.textContent = "";
    status.hidden = true;
  }
}
function showRecovered(visible: boolean) {
  show("recovered", visible);
  show("decrypt-heading", !visible);
  show("loaded-backup-id", !visible && !!loaded);
  show("decrypt-form", !visible && !!loaded);
  element("decrypt-view").setAttribute(
    "aria-labelledby",
    visible ? "recovered-heading" : "decrypt-heading",
  );
}
function clearRecovered() {
  clearRecoveredTextOnly();
  field("open-password").value = "";
  resetPasswordButtons(element("decrypt-view"));
}
function discardGenerated() {
  generated?.pdfs.A4.fill(0);
  generated?.pdfs.Letter.fill(0);
  generated = undefined;
  show("backup-result", false);
  element("backup-storage").textContent = "";
  element<HTMLImageElement>("qr").removeAttribute("src");
  report("print-help");
  for (const button of document.querySelectorAll<
    HTMLButtonElement | HTMLSelectElement
  >("[data-export]"))
    button.disabled = true;
}
function discardLoaded() {
  loaded?.fill(0);
  loaded = undefined;
  clearRecovered();
  show("decrypt-form", false);
  show("input-methods", true);
  backupLabel();
  report("decrypt-error");
}
function clearRecovery() {
  cancelOperation();
  stopCamera();
  discardLoaded();
  area("encoded").value = "";
  field("photo").value = "";
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
  element("encryption-summary").textContent =
    groups.length > 1
      ? "Enter two messages, choose a different strong password for each, and print them together as one encrypted QR code. Keep the passwords somewhere separate from the paper."
      : "Enter a message, choose a strong password, and print an encrypted QR code. Keep the password somewhere separate from the paper.";
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
  for (const [index, group] of groups.entries()) {
    const ordinal = ["First", "Second"][index];
    const messageLabel = groups.length === 1 ? "Message" : `${ordinal} message`;
    group.querySelector("legend")!.textContent = messageLabel;
    group.querySelector(`label[for="${textIn(group).id}"]`)!.textContent =
      messageLabel;
    group.querySelector(`label[for="${passwordIn(group).id}"]`)!.textContent =
      groups.length === 1 ? "Password" : `${ordinal} password`;
    const generate = group.querySelector<HTMLButtonElement>(
      "[data-generate-password]",
    )!;
    const generateLabel =
      groups.length === 1
        ? "Generate password"
        : `Generate password for ${ordinal.toLowerCase()} message`;
    generate.setAttribute("aria-label", generateLabel);
    generate.title = generateLabel;
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
  show("add-message", groups.length < MAX_MESSAGES);
  show("message-limit", groups.length >= MAX_MESSAGES);
}
function changed() {
  cancelOperation();
  discardGenerated();
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
  legend.className = "sr-only";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.id = "remove-message";
  remove.className = "remove-message";
  remove.textContent = "Remove message";
  remove.setAttribute("aria-label", "Remove message: second");
  remove.addEventListener("click", () => {
    if (operation) return;
    textIn(group).value = "";
    passwordIn(group).value = "";
    group.remove();
    remove.remove();
    changed();
    element("add-message").focus();
  });
  const textLabel = document.createElement("label");
  textLabel.htmlFor = `message-text-${suffix}`;
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
  toggle.className = "icon-button";
  toggle.dataset.show = password.id;
  toggle.setAttribute("aria-controls", password.id);
  showPasswordControl(toggle, false);
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "icon-button generate-password";
  generate.dataset.generatePassword = password.id;
  generate.setAttribute("aria-controls", password.id);
  generatePasswordControl(generate);
  passwordRow.append(password, generate, toggle);
  const passwordStatus = document.createElement("p");
  passwordStatus.id = `password-status-${suffix}`;
  passwordStatus.className = "hint password-generation-status";
  passwordStatus.dataset.passwordStatus = "";
  passwordStatus.setAttribute("role", "status");
  passwordStatus.hidden = true;
  password.setAttribute("aria-describedby", passwordStatus.id);
  group.append(
    legend,
    textLabel,
    text,
    capacity,
    passwordLabel,
    passwordRow,
    passwordStatus,
  );
  element("message-list").append(group);
  element("encrypt-actions").append(remove);
  changed();
  text.focus();
}

function setLoaded(bytes: Uint8Array, digest: string) {
  stopCamera();
  loaded?.fill(0);
  loaded = new Uint8Array(bytes);
  clearRecovered();
  area("encoded").value = "";
  show("input-methods", false);
  show("decrypt-form", true);
  report("decrypt-error");
  backupLabel(digest);
}
async function importBackup(
  read: () => Promise<Uint8Array> | Uint8Array,
  focusPassword = true,
) {
  stopCamera();
  discardLoaded();
  const job = beginOperation("Reading your backup…", true);
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
    if (loaded && revision === job.id)
      element(focusPassword ? "open-password" : "decrypt-heading").focus({
        preventScroll: !focusPassword,
      });
  }
}
async function readEncryptedText(text: string): Promise<Uint8Array> {
  if (text.length > MAX_ARCHIVE_CHARACTERS) throw new PaperError("format");
  // Only inspect the heading. Raw-text spaces remain untouched. A linked QR is
  // decoded locally; its address is data, never a navigation or network request.
  if (
    [ARCHIVE_LABEL, ARCHIVE_BEGIN].some((prefix) =>
      text.trimStart().startsWith(prefix),
    )
  )
    return decodeArchive(text);
  return decodeQrPayload(text);
}

function validInputs(id: string): boolean {
  for (const input of element(id).querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input, textarea")) {
    // Creation policy only: recovery must accept the password used for a backup.
    // Count NFC Unicode code points, not UTF-16 units or UTF-8 bytes.
    if (input instanceof HTMLInputElement && input.matches("[data-password]")) {
      const value = input.value;
      input.setCustomValidity(
        value &&
          value.length <= 4096 &&
          Array.from(value.normalize("NFC")).length < 7
          ? "Use at least 7 characters for a new password."
          : "",
      );
    }
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
  if (!button || button.matches(":disabled")) return;
  const input = field(button.dataset.show!);
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  showPasswordControl(button, visible);
});
document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-generate-password]",
  );
  if (!button || button.matches(":disabled") || operation) return;
  try {
    // Obtain a complete password before changing any fields or existing backup.
    const password = generatePassphrase();
    const input = field(button.dataset.generatePassword!);
    input.value = password;
    input.setCustomValidity("");
    input.type = "text";
    const group = input.closest<HTMLElement>("[data-message]")!;
    const toggle = group.querySelector<HTMLButtonElement>("[data-show]")!;
    showPasswordControl(toggle, true);
    changed();
    const status = group.querySelector<HTMLElement>("[data-password-status]")!;
    status.textContent =
      "Password generated. Record all eight words and keep them separately from your backup.";
    status.hidden = false;
  } catch {
    report(
      "encrypt-error",
      "This browser could not generate a secure password. Enter your own password or try another browser.",
    );
  }
});
element("encrypt-tab").addEventListener("click", () => chooseView("encrypt"));
element("decrypt-tab").addEventListener("click", () => chooseView("decrypt"));
element("add-message").addEventListener("click", addMessage);
element("encrypt-form").addEventListener("input", (event) => {
  if (
    event.target instanceof HTMLInputElement &&
    event.target.matches("[data-password]")
  ) {
    event.target.setCustomValidity("");
    const status = event.target
      .closest("[data-message]")!
      .querySelector<HTMLElement>("[data-password-status]")!;
    status.textContent = "";
    status.hidden = true;
  }
  changed();
});
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
    const written = await preparePrint(bytes, {
      signal: job.controller.signal,
    });
    if (!isCurrent(job)) return;
    generated = written;
    element<HTMLImageElement>("qr").src =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    element("backup-storage").textContent =
      `Keep this paper somewhere safe. You’ll need your ${messages.length === 1 ? "password" : "passwords"} to open it.`;
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

function savePdf() {
  if (!generated || operation) return;
  const paper = element<HTMLSelectElement>("paper-size").value;
  if (paper !== "A4" && paper !== "Letter") return;
  download(
    generated.pdfs[paper],
    "application/pdf",
    generated.words.replaceAll(" ", "-") + "-" + paper.toLowerCase() + ".pdf",
  );
  report(
    "print-help",
    "Open the saved PDF and print at actual size (100%), using the selected paper size.",
  );
}
element("print").addEventListener("click", savePdf);
element("save-text").addEventListener("click", () => {
  if (generated && !operation)
    download(
      generated.written,
      "text/plain;charset=utf-8",
      generated.words.replaceAll(" ", "-") + ".txt",
    );
});
element("scan").addEventListener("click", () => {
  cancelOperation();
  stopCamera();
  discardLoaded();
  show("camera", true);
  void camera.start();
});
element("stop-camera").addEventListener("click", stopCamera);
element("choose-photo").addEventListener("click", () => {
  cancelOperation();
  stopCamera();
  report("decrypt-error");
  photoSelectionRevision = revision;
  field("photo").click();
});
field("photo").addEventListener("cancel", () => {
  photoSelectionRevision = undefined;
});
field("photo").addEventListener("change", () => {
  const file = field("photo").files?.[0];
  const selectionRevision = photoSelectionRevision;
  photoSelectionRevision = undefined;
  field("photo").value = "";
  // A picker may return after a tab switch or another recovery action.
  if (file && selectionRevision === revision)
    void importBackup(() => scanFile(file));
});
area("encoded").addEventListener("input", () => {
  cancelOperation();
  stopCamera();
  discardLoaded();
  const text = area("encoded").value;
  if (text.length <= MAX_ARCHIVE_CHARACTERS && !text.trim()) return;
  // Wait briefly for typing or paste corrections. The same cancellation path
  // also discards this pending import when another input method is chosen.
  textImportTimer = window.setTimeout(() => {
    textImportTimer = undefined;
    void importBackup(() => readEncryptedText(text));
  }, 200);
});
element("open-button").addEventListener("click", async () => {
  if (operation || !loaded || !validInputs("decrypt-form")) return;
  report("decrypt-error");
  clearRecoveredTextOnly();
  const job = beginOperation("Decrypting your backup…");
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
    showRecovered(true);
    element("recovered-heading").focus();
  } catch (error) {
    if (isCurrent(job)) report("decrypt-error", friendly(error));
  } finally {
    finishOperation(job);
  }
});
function clearRecoveredTextOnly() {
  element("recovered-text").textContent = "";
  showRecovered(false);
}
for (const id of ["change-backup", "load-another"]) {
  element(id).addEventListener("click", () => {
    clearRecovery();
    area("encoded").focus();
  });
}
element("close-text").addEventListener("click", () => {
  clearRecovered();
  show("decrypt-form", !!loaded);
  field("open-password").focus();
});

setupDonations(stopCamera);

const about = element<HTMLDialogElement>("about-dialog");
element("about").addEventListener("click", () => {
  stopCamera();
  about.showModal();
});
element("close-about").addEventListener("click", () => about.close());
const checkDialog = element<HTMLDialogElement>("check-dialog");
for (const button of document.querySelectorAll("[data-open-verification]")) {
  button.addEventListener("click", () => {
    stopCamera();
    checkDialog.showModal();
  });
}
element("close-check").addEventListener("click", () => checkDialog.close());
const localCopy = location.protocol === "file:";
const contextAdvice = localCopy
  ? "Everything happens on this device."
  : "For anything important, use the offline app.";
element("encryption-context").textContent = contextAdvice;
element("recovery-context").textContent = contextAdvice;
element("reader-status").dataset.context = localCopy ? "local" : "hosted";
show("hosted-copy", !localCopy);
show("local-copy", localCopy);
show("save-reader", !localCopy);
if (localCopy) {
  element("reader-verify").textContent = "Verify it";
  element("reader-status-ending").textContent =
    " before entering sensitive information.";
}
const readerDownloads = document.querySelectorAll<HTMLButtonElement>(
  "button[data-save-reader]",
);
for (const button of readerDownloads)
  button.addEventListener("click", () =>
    download(originalRelease, "text/html;charset=utf-8", "paperwarden.html"),
  );
const aboutDownload = element<HTMLAnchorElement>("about-save-reader");
if (element<HTMLScriptElement>("application").src) {
  element("reader-status").dataset.context = "development";
  show("hosted-copy", false);
  show("local-copy", false);
  show("development-copy", true);
  show("reader-verify", false);
  show("reader-status-ending", false);
  aboutDownload.removeAttribute("href");
  aboutDownload.removeAttribute("download");
  aboutDownload.setAttribute("aria-disabled", "true");
  element("reader-build").textContent = "Development build";
  for (const button of readerDownloads) {
    button.disabled = true;
    button.title = "Build the standalone app to download an offline copy.";
  }
} else {
  // Keep one download URL for this document's lifetime, including back/forward
  // cache restores. It contains only the pristine app, never entered data.
  aboutDownload.href = URL.createObjectURL(
    new Blob([originalRelease], { type: "text/html;charset=utf-8" }),
  );
  // Hash the captured download bytes, never the live DOM or form contents.
  // Canonical releases serialize identically. This is not an independent read
  // of disk bytes or authentication: modified code can falsify its own display.
  void fingerprint(utf8.encode(originalRelease))
    .then((digest) => {
      const repository = "https://github.com/qecez/paperwarden";
      const tag = `sha256-${digest}`;
      element<HTMLAnchorElement>("published-checksum").href =
        `${repository}/releases/tag/${tag}`;
      element<HTMLAnchorElement>("reader-source").href =
        `${repository}/tree/${tag}`;
      element("reader-build").textContent = `Build ${digest.slice(0, 12)}`;
      element("reader-build").title = `Reader SHA-256: ${digest}`;
    })
    .catch(() => {
      // The generic releases link remains available if build identification fails.
    });
}

window.addEventListener("pagehide", () => {
  cancelOperation();
  stopCamera();
  clearRecovery();
  discardGenerated();
  for (const input of document.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input[data-password], #open-password, textarea:not([readonly])"))
    input.value = "";
  resetPasswordButtons();
  updateCapacity();
});
function loadRecoveryFragment(fragment: string) {
  clearRecovery();
  chooseView("decrypt", false);
  // All entry points use the same cancellable import and ID calculation.
  // Landing from a camera link should not open a keyboard or shift the viewport.
  void importBackup(() => decodeLinkFragment(fragment), false);
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
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-show]",
))
  showPasswordControl(button, false);
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-generate-password]",
))
  generatePasswordControl(button);
updateCapacity();
chooseView(location.protocol === "file:" ? "decrypt" : "encrypt", false);
if (initialFragment !== null) {
  loadRecoveryFragment(initialFragment);
}
