import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadFrontendModule(relativeUrl, exportedNames) {
    const source = readFileSync(new URL(relativeUrl, import.meta.url), "utf8")
        .replace('import { app } from "../../../scripts/app.js"', "const app = globalThis.__app;");
    const context = vm.createContext({
        __app: {
            graph: { setDirtyCanvas() {} },
            registerExtension() {},
        },
        console,
        requestAnimationFrame(callback) { callback(); },
        window: { setInterval() { return 1; }, clearInterval() {} },
        fetch: async () => { throw new Error("fetch is not expected in this test"); },
        Set,
        Date,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
    });
    vm.runInContext(
        `${source}\nglobalThis.__exports = { ${exportedNames.join(", ")} };`,
        context,
    );
    return context.__exports;
}

function widget(name) {
    return { name, value: "", hidden: false, options: {} };
}

const chatControls = loadFrontendModule(
    "../web/openrouter_chat_controls.js",
    ["syncWidgetVisibility", "parseModelCatalogResponse", "parseCreditsResponse", "migrateLegacyWidgetValues"],
);

const chatOnly = ["system_prompt", "image_generation_only", "web_search", "pdf_engine", "chat_mode", "reasoning_effort"];
const shared = ["user_message_box", "cheapest", "fastest", "aspect_ratio", "image_resolution", "temperature", "request_timeout"];
const videoOnly = ["video_mode", "video_prompt", "video_resolution", "video_aspect_ratio", "duration", "generate_audio", "poll_interval_seconds", "timeout_seconds", "provider_json"];
const node = {
    widgets: [...chatOnly, ...shared, ...videoOnly].map(widget),
    size: [320, 900],
    computeSize() {
        return [300, 40 + this.widgets.filter((item) => !item.hidden).length * 20];
    },
    setSize(size) { this.size = size; },
    setDirtyCanvas() {},
};

chatControls.syncWidgetVisibility(node, "chat");
assert(chatOnly.every((name) => !node.widgets.find((item) => item.name === name).hidden));
assert(shared.every((name) => !node.widgets.find((item) => item.name === name).hidden));
assert(videoOnly.every((name) => node.widgets.find((item) => item.name === name).hidden));

chatControls.syncWidgetVisibility(node, "image");
assert(chatOnly.every((name) => node.widgets.find((item) => item.name === name).hidden));
assert(shared.every((name) => !node.widgets.find((item) => item.name === name).hidden));
assert(videoOnly.every((name) => node.widgets.find((item) => item.name === name).hidden));

chatControls.syncWidgetVisibility(node, "video");
assert(chatOnly.every((name) => node.widgets.find((item) => item.name === name).hidden));
assert(shared.every((name) => node.widgets.find((item) => item.name === name).hidden));
assert(videoOnly.every((name) => !node.widgets.find((item) => item.name === name).hidden));
assert(node.size[1] < 900, "the node height should shrink to visible widgets");

await assert.rejects(
    () => chatControls.parseModelCatalogResponse({ ok: true, status: 200, text: async () => "" }),
    /empty model catalog response/,
);
await assert.rejects(
    () => chatControls.parseModelCatalogResponse({ ok: true, status: 200, text: async () => "not-json" }),
    /invalid model catalog response/,
);
assert.equal(
    JSON.stringify(await chatControls.parseModelCatalogResponse({ ok: true, status: 200, text: async () => '{"models":[]}' })),
    '{"models":[]}',
);
await assert.rejects(
    () => chatControls.parseCreditsResponse({ ok: true, status: 200, text: async () => "" }),
    /empty credits response/,
);
assert.equal(
    JSON.stringify(await chatControls.parseCreditsResponse({
        ok: true,
        status: 200,
        text: async () => '{"success":true,"credits":"Remaining: $12.345"}',
    })),
    '{"success":true,"credits":"Remaining: $12.345"}',
);

const currentWidgetNames = [
    "api_key", "request_type", "model", "seed", "control_after_generate",
    "system_prompt", "user_message_box", "image_generation_only", "web_search",
    "cheapest", "fastest", "aspect_ratio", "image_resolution", "temperature",
    "pdf_engine", "chat_mode", "reasoning_effort", "request_timeout", "video_mode",
    "video_prompt", "video_resolution", "video_aspect_ratio", "duration",
    "generate_audio", "poll_interval_seconds", "timeout_seconds", "provider_json",
    "openrouter_api_key_status",
];
const currentWidgets = currentWidgetNames.map((name) => ({ name, value: `default:${name}` }));
const legacyNames = currentWidgetNames.filter(
    (name) => !["reasoning_effort", "request_timeout", "openrouter_api_key_status"].includes(name),
);
const legacyByName = {
    video_mode: "text_to_video",
    video_prompt: "legacy video prompt",
    video_resolution: "720p",
    video_aspect_ratio: "16:9",
    duration: "8",
    generate_audio: true,
    poll_interval_seconds: 30,
    timeout_seconds: 900,
    provider_json: "",
};
const legacyInfo = {
    widgets_values: legacyNames.map((name) => name in legacyByName ? legacyByName[name] : `legacy:${name}`),
};
assert.equal(chatControls.migrateLegacyWidgetValues({ widgets: currentWidgets }, legacyInfo), true);
const migratedByName = Object.fromEntries(
    currentWidgetNames.map((name, index) => [name, legacyInfo.widgets_values[index]]),
);
assert.equal(migratedByName.reasoning_effort, "auto");
assert.equal(migratedByName.request_timeout, 120);
assert.equal(migratedByName.video_mode, "text_to_video");
assert.equal(migratedByName.video_prompt, "legacy video prompt");
assert.equal(migratedByName.video_resolution, "720p");
assert.equal(migratedByName.video_aspect_ratio, "16:9");
assert.equal(migratedByName.duration, "8");
assert.equal(migratedByName.poll_interval_seconds, 30);
assert.equal(migratedByName.timeout_seconds, 900);

const videoControls = loadFrontendModule(
    "../web/openrouter_video_controls.js",
    ["estimateVideoCost"],
);
const estimate = videoControls.estimateVideoCost(
    {
        supported_resolutions: ["480p", "720p"],
        pricing_skus: {
            cents_per_image_input: "0.2",
            cents_per_video_output_second_480p: "5",
            cents_per_video_output_second_720p: "7",
        },
    },
    {
        duration: 6,
        resolution: "720p",
        aspectRatio: "16:9",
        mode: "image_to_video",
        generateAudio: false,
        imageInputCount: 1,
    },
);
assert.equal(estimate.display, "$0.4220");

console.log("Frontend visibility and video cost tests passed.");
