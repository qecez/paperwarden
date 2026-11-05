import { beforeAll, expect, test } from "vitest";
import { build } from "esbuild";
import { bundledPackages, notices } from "../scripts/notices.mjs";

let metadata;
let text;
beforeAll(async () => {
  const result = await build({
    entryPoints: ["src/main.ts", "src/crypto/worker.ts"],
    outdir: "artifacts/notice-test",
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    format: "iife",
    loader: { ".svg": "text" },
    metafile: true,
  });
  metadata = result.metafile;
  text = await notices([metadata]);
});

test("standalone notices cover the code and assets actually shipped", () => {
  expect([...bundledPackages([metadata]).keys()]).toEqual([
    "node_modules/@zxing/library",
    "node_modules/dijkstrajs",
    "node_modules/hash-wasm",
    "node_modules/qrcode",
    "node_modules/ts-custom-error",
  ]);
  for (const attribution of [
    "Copyright (c) 2026 qecez",
    "Copyright (c) 2013-2016 Pavol Rusnak",
    "Roboto fonts",
    "Liberation Mono (PDF font subset)",
    "SIL OPEN FONT LICENSE Version 1.1",
    "Copyright 2011 Google Inc. All Rights Reserved.",
    "ZXing authors",
    "Copyright (c) 2005 Sun Microsystems, Inc.",
    "Wyatt Baldwin",
    "Copyright (c) 2020 Dani Biró",
    "Copyright 2012, Samuel Neves",
    "Copyright 2017 The Go Authors. All rights reserved.",
    "Copyright (c) Microsoft Corporation.",
    "Copyright (c) 2012 Ryan Day",
    "Copyright (c) 2019 Adrien Gibrat",
    "Cryptocurrency Icons",
    "CC0 1.0 Universal",
  ])
    expect(text).toContain(attribution);
  expect(text).not.toMatch(/===.*===/);
  expect(text).not.toMatch(/\n(?:yargs|pngjs|@zxing\/text-encoding) \d/);
});

test("shared terms appear once and notice generation is deterministic", async () => {
  expect(
    text.match(
      /Permission is hereby granted, free of charge, to any person obtaining a copy/g,
    ),
  ).toHaveLength(1);
  expect(text.match(/SIL OPEN FONT LICENSE Version 1\.1/g)).toHaveLength(1);
  expect(
    text.match(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/g),
  ).toHaveLength(1);
  const reversed = {
    ...metadata,
    outputs: Object.fromEntries(Object.entries(metadata.outputs).reverse()),
  };
  expect(await notices([reversed])).toBe(text);
});

test("package discovery excludes eliminated imports and handles nested packages", () => {
  const packages = bundledPackages([
    {
      outputs: {
        "app.js": {
          inputs: {
            "src/main.ts": { bytesInOutput: 100 },
            "node_modules/unused/index.js": { bytesInOutput: 0 },
            "node_modules/outer/node_modules/@scope/inner/index.js": {
              bytesInOutput: 10,
            },
          },
        },
      },
    },
  ]);
  expect([...packages.keys()]).toEqual([
    "node_modules/outer/node_modules/@scope/inner",
  ]);
});
