import bitcoinLogo from "./assets/bitcoin.svg?raw";
import moneroLogo from "./assets/monero.svg?raw";
import ethereumLogo from "./assets/ethereum.svg?raw";
import { donationQr } from "./donation-qr";

export const DONATIONS = [
  {
    name: "Bitcoin",
    scheme: "bitcoin",
    label: "Bitcoin address",
    logo: bitcoinLogo,
    address: "bc1qlr0gkrfpey0m5jvkfct6nsacawap3559m3q8lx",
  },
  {
    name: "Monero",
    scheme: "monero",
    label: "Monero address",
    logo: moneroLogo,
    address:
      "8BDPbH2SwPoFhX8W3oTUvU3vRfvJ2eb19UTYMacszvRAFngdGwqc539gbSAvo7D2AU7ueRkviRAocbjpcnSJUbthRVTTUdp",
  },
  {
    name: "EVMs",
    scheme: "ethereum",
    label: "ETH and stables on Ethereum and other EVM chains.",
    logo: ethereumLogo,
    address: "0x9309e0b6f7e72712e6ce36d0a471fbb42a200cd9",
  },
] as const;

/** Addresses, QR generation and logos are local; no payment service or network call. */
export function setupDonations(beforeOpen: () => void) {
  const dialog = document.getElementById(
    "donation-dialog",
  ) as HTMLDialogElement;
  const address = document.getElementById(
    "donation-address",
  ) as HTMLInputElement;
  const qr = document.getElementById("donation-qr") as HTMLImageElement;
  const label = document.getElementById("donation-label")!;
  const panel = document.getElementById("donation-panel")!;
  const status = document.getElementById("donation-status")!;
  document.getElementById("donation-label-space")!.textContent =
    DONATIONS[2].label;
  const tabs = Array.from(
    dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  let revision = 0;
  let selected = 0;
  let rendered = "";
  function renderQr() {
    if (!dialog.open) return;
    const available = Math.min(288, panel.clientWidth);
    const key = `${selected}:${available}`;
    if (!available || rendered === key) return;
    const coin = DONATIONS[selected];
    const image = donationQr(
      `${coin.scheme}:${coin.address}`,
      coin.logo,
      available,
    );
    qr.width = qr.height = image.pixels;
    qr.src = image.src;
    rendered = key;
  }
  new ResizeObserver(renderQr).observe(panel);
  function choose(index: number, focus = false) {
    revision++;
    selected = index;
    const coin = DONATIONS[index];
    address.value = coin.address;
    label.textContent = coin.label;
    renderQr();
    qr.alt = `${coin.name} donation address QR code`;
    panel.setAttribute("aria-labelledby", tabs[index].id);
    status.textContent = "";
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => choose(i));
    tab.addEventListener("keydown", (event) => {
      const target =
        event.key === "ArrowRight"
          ? (i + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (i + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : undefined;
      if (target === undefined) return;
      event.preventDefault();
      choose(target, true);
    });
  });
  document.getElementById("donate")!.addEventListener("click", () => {
    beforeOpen();
    dialog.showModal();
    choose(0);
  });
  document
    .getElementById("close-donations")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    revision++;
    status.textContent = "";
  });
  document
    .getElementById("copy-donation")!
    .addEventListener("click", async () => {
      const job = ++revision;
      const value = address.value;
      try {
        await navigator.clipboard.writeText(value);
        if (job === revision && dialog.open)
          status.textContent = "Address copied.";
      } catch {
        if (job !== revision || !dialog.open) return;
        address.focus();
        address.select();
        status.textContent = "Select and copy the address above.";
      }
    });
}
