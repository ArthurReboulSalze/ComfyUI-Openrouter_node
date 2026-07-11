import { app } from "../../../scripts/app.js"

const NODE_IDS = new Set(["OpenRouterNode", "openrouter_node"]);
const CATALOG_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CATALOG_FORCE_DEDUP_MS = 30 * 1000;

let catalogCache = null;
let catalogRequest = null;
let lastForcedCatalogRequest = 0;
const propertiesPanelNodes = new Set();
let propertiesPanelObserver = null;

const CHAT_ONLY_WIDGETS = [
    "system_prompt",
    "image_generation_only",
    "web_search",
    "pdf_engine",
    "chat_mode",
    "reasoning_effort",
];

const IMAGE_ONLY_WIDGETS = [];

const CHAT_SHARED_WIDGETS = [
    "user_message_box",
    "cheapest",
    "fastest",
    "aspect_ratio",
    "image_resolution",
    "temperature",
    "request_timeout",
];

const VIDEO_WIDGETS = [
    "video_mode",
    "video_prompt",
    "video_resolution",
    "video_aspect_ratio",
    "duration",
    "generate_audio",
    "poll_interval_seconds",
    "timeout_seconds",
    "provider_json",
];

const VIDEO_MODES = new Set([
    "text_to_video",
    "image_to_video",
    "start_end_frame_to_video",
    "reference_to_video",
]);

function migrateLegacyWidgetValues(node, info) {
    const values = info?.widgets_values;
    const widgets = node.widgets;
    if (!Array.isArray(values) || !Array.isArray(widgets)) {
        return false;
    }

    const currentNames = widgets.map((widget) => widget.name);
    const reasoningIndex = currentNames.indexOf("reasoning_effort");
    if (reasoningIndex < 0 || !VIDEO_MODES.has(String(values[reasoningIndex] ?? ""))) {
        return false;
    }

    const insertedDefaults = {
        reasoning_effort: "auto",
        request_timeout: 120,
    };
    const legacyNames = currentNames.filter(
        (name) => name !== "reasoning_effort" && name !== "request_timeout",
    );
    const migratedValues = currentNames.map((name, currentIndex) => {
        if (name in insertedDefaults) {
            return insertedDefaults[name];
        }
        if (name.startsWith("openrouter_") || name === "estimated_cost") {
            return widgets[currentIndex]?.value;
        }
        const legacyIndex = legacyNames.indexOf(name);
        return legacyIndex >= 0 && legacyIndex < values.length
            ? values[legacyIndex]
            : widgets[currentIndex]?.value;
    });

    info.widgets_values = migratedValues;
    console.info("[OpenRouter] Migrated legacy workflow widget values.");
    return true;
}

function normalizeValues(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    const ordered = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value);
        if (seen.has(text)) {
            continue;
        }
        seen.add(text);
        ordered.push(text);
    }
    return ordered;
}

async function requestModelCatalog(forceRefresh = false) {
    const now = Date.now();
    const shouldForce = forceRefresh
        && (!catalogCache || now - lastForcedCatalogRequest >= CATALOG_FORCE_DEDUP_MS);

    if (catalogRequest) {
        return catalogRequest;
    }
    if (forceRefresh && !shouldForce && catalogCache) {
        return catalogCache;
    }

    catalogRequest = fetch(`/openrouter/model_catalog${shouldForce ? "?refresh=1" : ""}`, {
        cache: "no-store",
    })
        .then(async (response) => {
            const data = await parseModelCatalogResponse(response);
            if (!response.ok || data.success === false) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            if (shouldForce) {
                lastForcedCatalogRequest = Date.now();
            }
            catalogCache = data;
            return data;
        })
        .catch((error) => {
            if (error instanceof TypeError) {
                throw new Error("Cannot reach ComfyUI while refreshing models.");
            }
            throw error;
        })
        .finally(() => {
            catalogRequest = null;
        });
    return catalogRequest;
}

async function parseModelCatalogResponse(response) {
    const responseText = await response.text();
    if (!responseText.trim()) {
        throw new Error(
            response.ok
                ? "ComfyUI returned an empty model catalog response."
                : `ComfyUI returned HTTP ${response.status} with an empty response.`,
        );
    }

    try {
        return JSON.parse(responseText);
    } catch {
        throw new Error(`ComfyUI returned an invalid model catalog response (HTTP ${response.status}).`);
    }
}

function replaceObjectContents(target, source) {
    for (const key of Object.keys(target)) {
        delete target[key];
    }
    Object.assign(target, source ?? {});
}

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name) ?? null;
}

function setWidgetValue(node, widget, value) {
    if (!widget) {
        return false;
    }

    const nextValue = String(value);
    const currentValue = widget.value == null ? "" : String(widget.value);
    if (currentValue === nextValue) {
        return false;
    }

    widget.value = nextValue;

    const widgetIndex = node.widgets?.indexOf(widget) ?? -1;
    if (widgetIndex >= 0 && Array.isArray(node.widgets_values)) {
        node.widgets_values[widgetIndex] = nextValue;
    }

    return true;
}

function setComboValues(widget, values) {
    if (!widget?.options) {
        return false;
    }

    const nextValues = normalizeValues(values);
    const currentValues = normalizeValues(widget.options.values);
    const sameLength = nextValues.length === currentValues.length;
    const sameValues = sameLength && nextValues.every((value, index) => value === currentValues[index]);
    if (sameValues) {
        return false;
    }

    widget.options.values = nextValues;
    return true;
}

function chooseValue(currentValue, values) {
    const currentText = currentValue == null ? "" : String(currentValue);
    if (values.includes(currentText)) {
        return currentText;
    }
    return values[0] ?? "";
}

function setWidgetHidden(widget, hidden) {
    if (!widget) {
        return false;
    }

    const nextHidden = Boolean(hidden);
    const previousHidden = Boolean(widget.hidden);
    widget.hidden = nextHidden;
    widget.options ??= {};
    widget.options.hidden = nextHidden;

    if (widget.inputEl) {
        widget.inputEl.style.display = nextHidden ? "none" : "";
    }

    return previousHidden !== nextHidden;
}

function applyPropertiesPanelVisibility(node) {
    if (typeof document === "undefined" || !node?.__openrouterPropertyVisibility) {
        return;
    }

    const nodeId = String(node.id ?? "");
    for (const row of document.querySelectorAll(".widget-item")) {
        if (!row.querySelector(`[node-id="${nodeId}"]`)) {
            continue;
        }
        const name = row.querySelector(".editable-text")?.textContent?.trim();
        if (!name || !(name in node.__openrouterPropertyVisibility)) {
            continue;
        }
        row.style.display = node.__openrouterPropertyVisibility[name] ? "none" : "";
    }
}

function trackPropertiesPanelVisibility(node, widgetName, hidden) {
    node.__openrouterPropertyVisibility ??= {};
    node.__openrouterPropertyVisibility[widgetName] = Boolean(hidden);
    propertiesPanelNodes.add(node);

    if (!propertiesPanelObserver && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
        propertiesPanelObserver = new MutationObserver(() => {
            for (const trackedNode of propertiesPanelNodes) {
                applyPropertiesPanelVisibility(trackedNode);
            }
        });
        propertiesPanelObserver.observe(document.body, { childList: true, subtree: true });
    }
}

function resizeNodeToVisibleWidgets(node) {
    requestAnimationFrame(() => {
        const computedSize = node.computeSize?.();
        if (computedSize && node.setSize) {
            const currentWidth = Array.isArray(node.size) ? Number(node.size[0]) : 0;
            node.setSize([Math.max(currentWidth || 0, computedSize[0]), computedSize[1]]);
        }
        node.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas(true, true);
    });
}

function syncWidgetVisibility(node, requestType) {
    let changed = false;
    for (const name of CHAT_ONLY_WIDGETS) {
        const widget = getWidget(node, name);
        const hidden = requestType !== "chat";
        changed = setWidgetHidden(widget, hidden) || changed;
        trackPropertiesPanelVisibility(node, name, hidden);
    }

    for (const name of IMAGE_ONLY_WIDGETS) {
        const widget = getWidget(node, name);
        const hidden = requestType !== "image";
        changed = setWidgetHidden(widget, hidden) || changed;
        trackPropertiesPanelVisibility(node, name, hidden);
    }

    for (const name of CHAT_SHARED_WIDGETS) {
        const widget = getWidget(node, name);
        const hidden = requestType !== "chat" && requestType !== "image";
        changed = setWidgetHidden(widget, hidden) || changed;
        trackPropertiesPanelVisibility(node, name, hidden);
    }

    for (const name of VIDEO_WIDGETS) {
        const widget = getWidget(node, name);
        const hidden = requestType !== "video";
        changed = setWidgetHidden(widget, hidden) || changed;
        trackPropertiesPanelVisibility(node, name, hidden);
    }

    requestAnimationFrame(() => applyPropertiesPanelVisibility(node));
    resizeNodeToVisibleWidgets(node);
    return changed;
}

function syncModelList(node, requestType, chatCapabilities, imageCapabilities, videoCapabilities, allModelValues) {
    const modelWidget = getWidget(node, "model");
    if (!modelWidget) {
        return;
    }

    let filteredValues;
    if (requestType === "chat") {
        const chatModelIds = Object.keys(chatCapabilities).filter(
            (id) => !imageCapabilities[id] || !imageCapabilities[id].is_image_only
        );
        const videoIds = new Set(Object.keys(videoCapabilities));
        filteredValues = allModelValues.filter(
            (id) => chatModelIds.includes(id) && !videoIds.has(id)
        );
    } else if (requestType === "image") {
        const imageModelIds = Object.keys(imageCapabilities);
        filteredValues = allModelValues.filter((id) => imageModelIds.includes(id));
    } else if (requestType === "video") {
        const videoIds = new Set(Object.keys(videoCapabilities));
        filteredValues = allModelValues.filter((id) => videoIds.has(id));
    }

    if (!filteredValues || !filteredValues.length) {
        return;
    }

    let changed = false;
    changed = setComboValues(modelWidget, filteredValues) || changed;
    const nextModel = chooseValue(modelWidget.value, filteredValues);
    changed = setWidgetValue(node, modelWidget, nextModel) || changed;

    if (changed) {
        requestAnimationFrame(() => {
            const size = node.computeSize?.();
            if (size) {
                node.onResize?.(size);
            }
            app.graph.setDirtyCanvas(true, true);
        });
    }
}

function syncChatModelFilter(node, globals, chatCapabilities, videoCapabilities = {}) {
    const modelWidget = getWidget(node, "model");
    const imageOnlyWidget = getWidget(node, "image_generation_only");
    if (!modelWidget || !imageOnlyWidget) {
        return;
    }

    const requestType = String(getWidget(node, "request_type")?.value ?? "chat");
    if (requestType !== "chat") {
        return;
    }

    const imageGenerationOnly = Boolean(imageOnlyWidget.value);
    const videoIds = new Set(Object.keys(videoCapabilities));
    const chatModelIds = globals.allModelValues.filter(
        (id) => chatCapabilities[id] && !chatCapabilities[id].is_image_only && !videoIds.has(id)
    );
    const filteredValues = imageGenerationOnly
        ? chatModelIds.filter((modelId) => chatCapabilities[modelId]?.supports_image_generation)
        : chatModelIds;

    let changed = false;
    changed = setComboValues(modelWidget, filteredValues) || changed;
    const nextModelValue = chooseValue(modelWidget.value, filteredValues);
    changed = setWidgetValue(node, modelWidget, nextModelValue) || changed;

    if (changed) {
        requestAnimationFrame(() => {
            const size = node.computeSize?.();
            if (size) {
                node.onResize?.(size);
            }
            app.graph.setDirtyCanvas(true, true);
        });
    }
}

function configureModelCatalog(node, globals, chatCapabilities, imageCapabilities, videoCapabilities) {
    if (node.__openrouterCatalogConfigured) {
        return;
    }
    node.__openrouterCatalogConfigured = true;

    let statusWidget = getWidget(node, "openrouter_model_catalog_status");
    if (!statusWidget) {
        statusWidget = node.addWidget(
            "text",
            "openrouter_model_catalog_status",
            "Models: synchronizing...",
            () => {},
            { readonly: true, serialize: false },
        );
        statusWidget.serializeValue = () => undefined;
        if (statusWidget.inputEl) {
            statusWidget.inputEl.readOnly = true;
        }
    }

    const applyCatalog = (catalog) => {
        const models = normalizeValues(catalog.models);
        globals.allModelValues.splice(0, globals.allModelValues.length, ...models);
        replaceObjectContents(chatCapabilities, catalog.chat_capabilities);
        replaceObjectContents(imageCapabilities, catalog.image_capabilities);
        replaceObjectContents(videoCapabilities, catalog.video_capabilities);

        const requestType = String(getWidget(node, "request_type")?.value ?? "chat");
        syncModelList(node, requestType, chatCapabilities, imageCapabilities, videoCapabilities, globals.allModelValues);
        if (requestType === "chat") {
            syncChatModelFilter(node, globals, chatCapabilities, videoCapabilities);
        } else if (requestType === "video") {
            const modelWidget = getWidget(node, "model");
            modelWidget?.callback?.(modelWidget.value);
        }

        const counts = catalog.counts ?? {};
        const updatedAt = catalog.updated_at ? new Date(catalog.updated_at * 1000).toLocaleTimeString() : "now";
        statusWidget.value = `Models: ${counts.chat ?? 0} chat / ${counts.image ?? 0} image / ${counts.video ?? 0} video (${updatedAt})`;
        app.graph.setDirtyCanvas(true, true);
    };

    const refresh = async (forceRefresh = true) => {
        statusWidget.value = "Models: synchronizing...";
        try {
            applyCatalog(await requestModelCatalog(forceRefresh));
        } catch (error) {
            statusWidget.value = `Model refresh failed: ${error.message}`;
            app.graph.setDirtyCanvas(true, true);
        }
    };

    const buttonWidget = node.addWidget(
        "button",
        "openrouter_model_catalog_refresh",
        "Refresh Models",
        () => refresh(true),
        { serialize: false },
    );
    buttonWidget.serializeValue = () => undefined;

    refresh(true);
    node.__openrouterCatalogTimer = window.setInterval(() => refresh(true), CATALOG_REFRESH_INTERVAL_MS);

    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
        if (this.__openrouterCatalogTimer) {
            window.clearInterval(this.__openrouterCatalogTimer);
            this.__openrouterCatalogTimer = null;
        }
        propertiesPanelNodes.delete(this);
        return onRemoved?.apply(this, arguments);
    };
}

function wrapWidgetCallback(node, widgetName, callback) {
    const widget = getWidget(node, widgetName);
    if (!widget || widget.__openrouterChatWrapped) {
        return;
    }

    const originalCallback = widget.callback;
    widget.callback = (...args) => {
        const callbackResult = originalCallback?.apply(widget, args);
        requestAnimationFrame(() => {
            callback();
        });
        return callbackResult;
    };
    widget.__openrouterChatWrapped = true;
}

function configureApiKeyWidget(node) {
    const apiKeyWidget = getWidget(node, "api_key");
    if (!apiKeyWidget || apiKeyWidget.__openrouterApiKeySecured) {
        return;
    }

    apiKeyWidget.__openrouterApiKeySecured = true;

    apiKeyWidget.hidden = true;
    apiKeyWidget.serializeValue = () => "";

    let statusWidget = getWidget(node, "openrouter_api_key_status");
    if (!statusWidget) {
        statusWidget = node.addWidget(
            "text",
            "openrouter_api_key_status",
            "API key: not set",
            () => {},
            { readonly: true, serialize: false },
        );
        statusWidget.serializeValue = () => undefined;
        if (statusWidget.inputEl) {
            statusWidget.inputEl.readOnly = true;
        }
    }

    let buttonWidget = getWidget(node, "openrouter_api_key_button");
    if (!buttonWidget) {
        buttonWidget = node.addWidget(
            "button",
            "openrouter_api_key_button",
            "Set API Key",
            async () => {
                const current = apiKeyWidget.value && apiKeyWidget.value !== "" ? String(apiKeyWidget.value) : "";
                const entered = window.prompt("Enter your OpenRouter API key", current && !current.includes("...") ? current : "");
                if (entered === null) {
                    return;
                }

                const nextKey = entered.trim();
                try {
                    if (!nextKey) {
                        const response = await fetch("/openrouter/delete_api_key", { method: "POST" });
                        const data = await response.json();
                        if (!data.success) {
                            throw new Error(data.error || "Could not delete API key");
                        }
                        apiKeyWidget.value = "";
                        statusWidget.value = "API key: not set";
                        const creditsStatus = getWidget(node, "openrouter_credits_status");
                        if (creditsStatus) {
                            creditsStatus.value = "Credits: API key not set";
                        }
                    } else {
                        const response = await fetch("/openrouter/save_api_key", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ api_key: nextKey }),
                        });
                        const data = await response.json();
                        if (!data.success) {
                            throw new Error(data.error || "Could not save API key");
                        }
                        apiKeyWidget.value = data.masked || "saved";
                        statusWidget.value = `API key saved: ${data.masked || "saved"}`;
                    }

                    const size = node.computeSize?.();
                    if (size) {
                        node.onResize?.(size);
                    }
                    app.graph.setDirtyCanvas(true, true);
                } catch (error) {
                    statusWidget.value = `API key error: ${error.message}`;
                    app.graph.setDirtyCanvas(true, true);
                }
            },
            { serialize: false },
        );
        buttonWidget.serializeValue = () => undefined;
    }

    fetch("/openrouter/api_key_status")
        .then((r) => r.json())
        .then((data) => {
            if (data.saved && data.masked) {
                apiKeyWidget.value = data.masked;
                if (statusWidget) {
                    const environmentSources = new Set(["OPENROUTER_API_KEY", "LLM_KEY"]);
                    statusWidget.value = environmentSources.has(data.source)
                        ? `API key loaded from ${data.source}: ${data.masked}`
                        : data.source === "json"
                            ? `API key loaded from JSON config: ${data.masked}`
                            : `API key saved locally: ${data.masked}`;
                }
            } else if (statusWidget) {
                statusWidget.value = "API key: not set";
            }
        })
        .catch(() => {});
}

async function parseCreditsResponse(response) {
    const responseText = await response.text();
    if (!responseText.trim()) {
        throw new Error(
            response.ok
                ? "ComfyUI returned an empty credits response."
                : `ComfyUI returned HTTP ${response.status} with an empty credits response.`,
        );
    }

    let data;
    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(`ComfyUI returned an invalid credits response (HTTP ${response.status}).`);
    }

    if (!response.ok || data.success === false) {
        throw new Error(data.error || `Could not refresh credits (HTTP ${response.status}).`);
    }
    return data;
}

function configureCreditsWidget(node) {
    if (node.__openrouterCreditsConfigured) {
        return;
    }
    node.__openrouterCreditsConfigured = true;

    let statusWidget = getWidget(node, "openrouter_credits_status");
    if (!statusWidget) {
        statusWidget = node.addWidget(
            "text",
            "openrouter_credits_status",
            "Credits: click Refresh Credits",
            () => {},
            { readonly: true, serialize: false },
        );
        statusWidget.label = "OpenRouter credits";
        statusWidget.serializeValue = () => undefined;
        if (statusWidget.inputEl) {
            statusWidget.inputEl.readOnly = true;
        }
    }

    let buttonWidget = getWidget(node, "openrouter_refresh_credits_button");
    if (!buttonWidget) {
        buttonWidget = node.addWidget(
            "button",
            "openrouter_refresh_credits_button",
            "Refresh Credits",
            async () => {
                statusWidget.value = "Credits: refreshing...";
                app.graph.setDirtyCanvas(true, true);
                try {
                    const response = await fetch("/openrouter/credits", { cache: "no-store" });
                    const data = await parseCreditsResponse(response);
                    statusWidget.value = `${data.credits} · ${new Date().toLocaleTimeString()}`;
                } catch (error) {
                    statusWidget.value = error instanceof TypeError
                        ? "Credits: cannot reach ComfyUI"
                        : `Credits error: ${error.message}`;
                }
                resizeNodeToVisibleWidgets(node);
            },
            { serialize: false },
        );
        buttonWidget.serializeValue = () => undefined;
    }

    resizeNodeToVisibleWidgets(node);
}

app.registerExtension({
    name: "OpenRouter.ChatControls",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_IDS.has(nodeData.name)) {
            return;
        }

        const globals = {
            allModelValues: normalizeValues(nodeData.input?.required?.model?.[0]),
        };
        const chatCapabilities = nodeData.input?.required?.model?.[1]?.chat_capabilities ?? {};
        const imageCapabilities = nodeData.input?.required?.model?.[1]?.image_capabilities ?? {};
        const videoCapabilities = nodeData.input?.required?.model?.[1]?.video_capabilities ?? {};

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            syncWidgetVisibility(this, "chat");
            configureApiKeyWidget(this);
            configureCreditsWidget(this);
            configureModelCatalog(this, globals, chatCapabilities, imageCapabilities, videoCapabilities);

            wrapWidgetCallback(this, "request_type", () => {
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                syncWidgetVisibility(this, requestType);
                syncModelList(this, requestType, chatCapabilities, imageCapabilities, videoCapabilities, globals.allModelValues);
            });

            wrapWidgetCallback(this, "image_generation_only", () => {
                syncChatModelFilter(this, globals, chatCapabilities, videoCapabilities);
            });

            requestAnimationFrame(() => {
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                syncWidgetVisibility(this, requestType);
                syncModelList(this, requestType, chatCapabilities, imageCapabilities, videoCapabilities, globals.allModelValues);
                syncChatModelFilter(this, globals, chatCapabilities, videoCapabilities);
            });

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            migrateLegacyWidgetValues(this, arguments[0]);
            onConfigure?.apply(this, arguments);
            configureApiKeyWidget(this);
            configureCreditsWidget(this);
            configureModelCatalog(this, globals, chatCapabilities, imageCapabilities, videoCapabilities);
            requestAnimationFrame(() => {
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                syncWidgetVisibility(this, requestType);
                syncModelList(this, requestType, chatCapabilities, imageCapabilities, videoCapabilities, globals.allModelValues);
                syncChatModelFilter(this, globals, chatCapabilities, videoCapabilities);
            });
        };
    },
})
