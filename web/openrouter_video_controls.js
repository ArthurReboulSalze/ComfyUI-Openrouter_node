import { app } from "../../../scripts/app.js"

const NODE_IDS = new Set(["OpenRouterNode", "openrouter_node"]);
const AUTO_VALUE = "auto";
const ESTIMATED_COST_WIDGET = "estimated_cost";
const LEGACY_PRICING_NOTE_WIDGET = "pricing_note";

function normalizeValues(values, fallback = []) {
    if (!Array.isArray(values)) {
        return [...fallback];
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

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name) ?? null;
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

function syncPropertiesPanelCostVisibility(node, hidden) {
    node.__openrouterPropertyVisibility ??= {};
    node.__openrouterPropertyVisibility[ESTIMATED_COST_WIDGET] = Boolean(hidden);
    node.__openrouterPropertyVisibility["Estimated video cost (USD)"] = Boolean(hidden);

    if (typeof document === "undefined") {
        return;
    }
    const nodeId = String(node.id ?? "");
    for (const row of document.querySelectorAll(".widget-item")) {
        if (!row.querySelector(`[node-id="${nodeId}"]`)) {
            continue;
        }
        const name = row.querySelector(".editable-text")?.textContent?.trim();
        if (name === ESTIMATED_COST_WIDGET || name === "Estimated video cost (USD)") {
            row.style.display = hidden ? "none" : "";
        }
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

function removeWidget(node, widgetName) {
    const widget = getWidget(node, widgetName);
    if (!widget || !Array.isArray(node.widgets)) {
        return false;
    }

    const widgetIndex = node.widgets.indexOf(widget);
    if (widgetIndex < 0) {
        return false;
    }

    widget.onRemove?.();
    node.widgets.splice(widgetIndex, 1);
    if (Array.isArray(node.widgets_values)) {
        node.widgets_values.splice(widgetIndex, 1);
    }
    return true;
}

function parsePrice(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseDuration(value) {
    if (value == null || value === "" || value === AUTO_VALUE) {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return null;
    }

    return Math.trunc(parsed);
}

function parseVideoSize(size) {
    if (typeof size !== "string" || !size.includes("x")) {
        return null;
    }

    const [widthText, heightText] = size.toLowerCase().split("x", 2);
    const width = Number(widthText);
    const height = Number(heightText);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    return { width, height };
}

function gcd(a, b) {
    let left = Math.abs(a);
    let right = Math.abs(b);
    while (right !== 0) {
        const temp = right;
        right = left % right;
        left = temp;
    }
    return left || 1;
}

function simplifyRatio(width, height) {
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function sizeMatchesResolution(size, resolution) {
    if (!resolution || resolution === AUTO_VALUE) {
        return true;
    }

    const parsed = parseVideoSize(size);
    if (!parsed) {
        return false;
    }

    const shortSide = Math.min(parsed.width, parsed.height);
    const longSide = Math.max(parsed.width, parsed.height);
    const normalized = String(resolution).toLowerCase();

    if (normalized === "480p") {
        return shortSide === 480;
    }
    if (normalized === "720p") {
        return shortSide === 720;
    }
    if (normalized === "1080p") {
        return shortSide === 1080;
    }
    if (normalized === "4k") {
        return longSide === 3840 || longSide === 4096 || shortSide === 2160;
    }
    return true;
}

function sizeMatchesAspectRatio(size, aspectRatio) {
    if (!aspectRatio || aspectRatio === AUTO_VALUE) {
        return true;
    }

    const parsed = parseVideoSize(size);
    if (!parsed) {
        return false;
    }

    return simplifyRatio(parsed.width, parsed.height) === String(aspectRatio);
}

function matchingSupportedSizes(modelCapabilities, resolution, aspectRatio) {
    const sizes = normalizeValues(modelCapabilities.supported_sizes);
    return sizes.filter((size) => sizeMatchesResolution(size, resolution) && sizeMatchesAspectRatio(size, aspectRatio));
}

function resolutionSuffixes(resolution) {
    if (!resolution || resolution === AUTO_VALUE) {
        return [];
    }

    const normalized = String(resolution).toLowerCase();
    const mapping = {
        "480p": ["480p"],
        "720p": ["720p"],
        "1080p": ["1080p"],
        "1k": ["1k", "1024p"],
        "2k": ["2k", "2048p"],
        "4k": ["4k", "2160p"],
    };
    return mapping[normalized] ?? [normalized];
}

function formatCostDisplay(minCost, maxCost) {
    if (minCost == null || maxCost == null) {
        return "N/A";
    }
    if (Math.abs(minCost - maxCost) < 1e-9) {
        return `$${minCost.toFixed(4)}`;
    }
    return `$${minCost.toFixed(4)}-$${maxCost.toFixed(4)}`;
}

function estimateTokenPricedCost(modelCapabilities, settings) {
    const duration = settings.duration;
    if (!Number.isFinite(duration)) {
        return null;
    }

    const pricingSkus = modelCapabilities.pricing_skus ?? {};
    const generateAudio = settings.generateAudio !== false;
    const skuKey = !generateAudio && pricingSkus.video_tokens_without_audio ? "video_tokens_without_audio" : "video_tokens";
    const rate = parsePrice(pricingSkus[skuKey]);
    if (rate == null) {
        return null;
    }

    let sizes = matchingSupportedSizes(modelCapabilities, settings.resolution, settings.aspectRatio);
    if (!sizes.length) {
        sizes = normalizeValues(modelCapabilities.supported_sizes);
    }
    if (!sizes.length) {
        return null;
    }

    const costs = [];
    for (const size of sizes) {
        const parsed = parseVideoSize(size);
        if (!parsed) {
            continue;
        }

        const tokenCount = (parsed.width * parsed.height * duration * 24) / 1024;
        costs.push(tokenCount * rate);
    }

    if (!costs.length) {
        return null;
    }

    return {
        display: formatCostDisplay(Math.min(...costs), Math.max(...costs)),
        note: costs.length > 1
            ? "Estimate spans multiple published sizes. Select both aspect ratio and resolution to narrow it down."
            : "Estimate is based on the published size matching the current selection.",
    };
}

function estimateModeResolutionCost(modelCapabilities, settings) {
    const duration = settings.duration;
    if (!Number.isFinite(duration)) {
        return null;
    }

    const pricingSkus = modelCapabilities.pricing_skus ?? {};
    const prefix = settings.mode === "text_to_video" ? "text_to_video" : "image_to_video";
    const candidateResolutions = settings.resolution && settings.resolution !== AUTO_VALUE
        ? [settings.resolution]
        : normalizeValues(modelCapabilities.supported_resolutions);

    const costs = [];
    for (const resolution of candidateResolutions) {
        for (const suffix of resolutionSuffixes(resolution)) {
            const skuKey = `${prefix}_duration_seconds_${suffix}`;
            const rate = parsePrice(pricingSkus[skuKey]);
            if (rate == null) {
                continue;
            }
            costs.push(duration * rate);
            break;
        }
    }

    if (!costs.length) {
        return null;
    }

    return {
        display: formatCostDisplay(Math.min(...costs), Math.max(...costs)),
        note: costs.length > 1
            ? "Estimate spans multiple possible resolutions for this mode."
            : "Estimate is based on the selected mode and resolution.",
    };
}

function estimateDurationCost(modelCapabilities, settings) {
    const duration = settings.duration;
    if (!Number.isFinite(duration)) {
        return null;
    }

    const pricingSkus = modelCapabilities.pricing_skus ?? {};
    const generateAudio = settings.generateAudio !== false;
    const candidateResolutions = settings.resolution && settings.resolution !== AUTO_VALUE
        ? [settings.resolution]
        : normalizeValues(modelCapabilities.supported_resolutions).length
            ? normalizeValues(modelCapabilities.supported_resolutions)
            : [null];

    const costs = [];
    for (const resolution of candidateResolutions) {
        const suffixes = resolutionSuffixes(resolution);
        const keyCandidates = [];

        if (generateAudio) {
            keyCandidates.push(...suffixes.map((suffix) => `duration_seconds_with_audio_${suffix}`));
            keyCandidates.push("duration_seconds_with_audio");
        } else {
            keyCandidates.push(...suffixes.map((suffix) => `duration_seconds_without_audio_${suffix}`));
            keyCandidates.push("duration_seconds_without_audio");
        }

        keyCandidates.push(...suffixes.map((suffix) => `duration_seconds_${suffix}`));
        keyCandidates.push("duration_seconds");

        for (const skuKey of keyCandidates) {
            const rate = parsePrice(pricingSkus[skuKey]);
            if (rate == null) {
                continue;
            }
            costs.push(duration * rate);
            break;
        }
    }

    if (!costs.length) {
        return null;
    }

    return {
        display: formatCostDisplay(Math.min(...costs), Math.max(...costs)),
        note: costs.length > 1
            ? "Estimate spans multiple published resolutions for this model."
            : "Estimate is based on the model's public pricing SKUs.",
    };
}

function estimateCentsPerSecondCost(modelCapabilities, settings) {
    const duration = settings.duration;
    if (!Number.isFinite(duration)) {
        return null;
    }

    const pricingSkus = modelCapabilities.pricing_skus ?? {};
    const candidateResolutions = settings.resolution && settings.resolution !== AUTO_VALUE
        ? [settings.resolution]
        : normalizeValues(modelCapabilities.supported_resolutions).length
            ? normalizeValues(modelCapabilities.supported_resolutions)
            : [null];
    const imageInputCost = (parsePrice(pricingSkus.cents_per_image_input) ?? 0)
        * (settings.imageInputCount ?? 0)
        / 100;
    const costs = [];

    for (const resolution of candidateResolutions) {
        const keyCandidates = [
            ...resolutionSuffixes(resolution).map((suffix) => `cents_per_video_output_second_${suffix}`),
            "cents_per_video_output_second",
        ];
        for (const skuKey of keyCandidates) {
            const centsPerSecond = parsePrice(pricingSkus[skuKey]);
            if (centsPerSecond == null) {
                continue;
            }
            costs.push((duration * centsPerSecond) / 100 + imageInputCost);
            break;
        }
    }

    if (!costs.length) {
        return null;
    }

    return {
        display: formatCostDisplay(Math.min(...costs), Math.max(...costs)),
        note: costs.length > 1
            ? "Estimate spans the published per-second prices for possible resolutions."
            : "Estimate uses the published per-second price and connected image inputs.",
    };
}

function estimateVideoCost(modelCapabilities, settings) {
    const pricingSkus = modelCapabilities.pricing_skus ?? {};
    const pricingKeys = Object.keys(pricingSkus);
    if (!pricingKeys.length) {
        return {
            display: "N/A",
            note: "Public pricing data is not available for this model.",
        };
    }

    if (pricingKeys.some((key) => key.startsWith("cents_per_video_output_second"))) {
        return estimateCentsPerSecondCost(modelCapabilities, settings)
            ?? {
                display: "N/A",
                note: "Select a duration and resolution to estimate this model.",
            };
    }

    if (pricingKeys.some((key) => key.startsWith("text_to_video_duration_seconds_") || key.startsWith("image_to_video_duration_seconds_"))) {
        return estimateModeResolutionCost(modelCapabilities, settings)
            ?? {
                display: "N/A",
                note: "Not enough information to estimate cost yet. Duration and resolution matter most here.",
            };
    }

    if (pricingKeys.includes("video_tokens") || pricingKeys.includes("video_tokens_without_audio")) {
        return estimateTokenPricedCost(modelCapabilities, settings)
            ?? {
                display: "N/A",
                note: "Not enough information to estimate cost yet. Duration, resolution, and aspect ratio matter most here.",
            };
    }

    return estimateDurationCost(modelCapabilities, settings)
        ?? {
            display: "N/A",
            note: "Not enough information to estimate cost yet. Duration matters most here.",
        };
}

function ensureInfoWidgets(node) {
    removeWidget(node, LEGACY_PRICING_NOTE_WIDGET);

    let estimatedCostWidget = getWidget(node, ESTIMATED_COST_WIDGET);
    if (!estimatedCostWidget) {
        estimatedCostWidget = node.addWidget(
            "text",
            ESTIMATED_COST_WIDGET,
            "N/A",
            () => {},
            { readonly: true, serialize: false },
        );
        estimatedCostWidget.serializeValue = () => undefined;
        if (estimatedCostWidget.inputEl) {
            estimatedCostWidget.inputEl.readOnly = true;
            estimatedCostWidget.inputEl.style.opacity = "0.85";
        }
    }
    estimatedCostWidget.label = "Estimated video cost (USD)";
    return { estimatedCostWidget };
}

function configureAdvancedProviderWidget(node) {
    const providerWidget = getWidget(node, "provider_json");
    if (!providerWidget) {
        return false;
    }

    if (providerWidget.inputEl) {
        providerWidget.inputEl.placeholder = "Optional provider options JSON (advanced)";
        providerWidget.inputEl.title = "Optional provider routing/options JSON for advanced OpenRouter video settings.";
        providerWidget.inputEl.style.opacity = "0.92";
    }

    const currentValue = providerWidget.value == null ? "" : String(providerWidget.value).trim();
    if (currentValue === "{}") {
        return setWidgetValue(node, providerWidget, "");
    }

    return false;
}

function getCurrentSettings(node) {
    const mode = getWidget(node, "video_mode")?.value ?? "text_to_video";
    const relevantImageInputs = mode === "image_to_video"
        ? ["video_frame_1"]
        : mode === "start_end_frame_to_video"
            ? ["video_frame_1", "video_frame_2"]
            : mode === "reference_to_video"
                ? ["reference_image_1", "reference_image_2", "reference_image_3", "reference_image_4"]
                : [];
    const imageInputCount = (node.inputs ?? []).filter(
        (input) => relevantImageInputs.includes(input.name) && input.link != null
    ).length;

    return {
        mode,
        resolution: getWidget(node, "video_resolution")?.value ?? AUTO_VALUE,
        aspectRatio: getWidget(node, "video_aspect_ratio")?.value ?? AUTO_VALUE,
        duration: parseDuration(getWidget(node, "duration")?.value),
        generateAudio: Boolean(getWidget(node, "generate_audio")?.value),
        imageInputCount,
    };
}

function syncEstimatedCost(node, capabilities) {
    const requestType = String(getWidget(node, "request_type")?.value ?? "chat");
    if (requestType !== "video") {
        const estimatedCostWidget = getWidget(node, ESTIMATED_COST_WIDGET);
        syncPropertiesPanelCostVisibility(node, true);
        return setWidgetHidden(estimatedCostWidget, true);
    }

    const modelWidget = getWidget(node, "model");
    const { estimatedCostWidget } = ensureInfoWidgets(node);
    if (!modelWidget || !estimatedCostWidget) {
        return false;
    }

    syncPropertiesPanelCostVisibility(node, false);
    let changed = setWidgetHidden(estimatedCostWidget, false);

    const modelId = modelWidget.value == null ? "" : String(modelWidget.value);
    const modelCapabilities = capabilities[modelId] ?? {};
    const settings = getCurrentSettings(node);
    const estimate = estimateVideoCost(modelCapabilities, settings);

    estimatedCostWidget.options ??= {};
    estimatedCostWidget.options.tooltip = estimate?.note ?? "";
    if (estimatedCostWidget.inputEl) {
        estimatedCostWidget.inputEl.title = estimate?.note ?? "";
    }

    changed = setWidgetValue(node, estimatedCostWidget, estimate?.display ?? "N/A") || changed;
    return changed;
}

function wrapWidgetCallback(node, widgetName, callback) {
    const widget = getWidget(node, widgetName);
    if (!widget || widget.__openrouterVideoWrapped) {
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
    widget.__openrouterVideoWrapped = true;
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
    if (
        widgetIndex >= 0
        && Array.isArray(node.widgets_values)
        && widget.options?.serialize !== false
    ) {
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

function chooseValue(currentValue, values, fallbackValue) {
    const currentText = currentValue == null ? "" : String(currentValue);
    if (values.includes(currentText)) {
        return currentText;
    }
    if (fallbackValue != null && values.includes(String(fallbackValue))) {
        return String(fallbackValue);
    }
    return values[0] ?? "";
}

function syncVideoWidgets(node, globals, capabilities, options = {}) {
    const requestType = String(getWidget(node, "request_type")?.value ?? "chat");
    if (requestType !== "video") {
        return;
    }

    const modelWidget = getWidget(node, "model");
    if (!modelWidget) {
        return;
    }

    const modelId = modelWidget.value == null ? "" : String(modelWidget.value);
    const modelCapabilities = capabilities[modelId] ?? {};

    const modeWidget = getWidget(node, "video_mode");
    const resolutionWidget = getWidget(node, "video_resolution");
    const aspectRatioWidget = getWidget(node, "video_aspect_ratio");
    const durationWidget = getWidget(node, "duration");

    const modeValues = normalizeValues(
        modelCapabilities.supported_modes?.length ? modelCapabilities.supported_modes : globals.modeValues,
        globals.modeValues,
    );
    const resolutionValues = normalizeValues(
        modelCapabilities.supported_resolutions?.length
            ? [AUTO_VALUE, ...modelCapabilities.supported_resolutions]
            : globals.resolutionValues,
        globals.resolutionValues,
    );
    const aspectRatioValues = normalizeValues(
        modelCapabilities.supported_aspect_ratios?.length
            ? [AUTO_VALUE, ...modelCapabilities.supported_aspect_ratios]
            : globals.aspectRatioValues,
        globals.aspectRatioValues,
    );
    const durationValues = normalizeValues(
        modelCapabilities.supported_durations?.length
            ? [AUTO_VALUE, ...modelCapabilities.supported_durations]
            : globals.durationValues,
        globals.durationValues,
    );

    let changed = false;
    changed = setComboValues(modeWidget, modeValues) || changed;
    changed = setComboValues(resolutionWidget, resolutionValues) || changed;
    changed = setComboValues(aspectRatioWidget, aspectRatioValues) || changed;
    changed = setComboValues(durationWidget, durationValues) || changed;

    if (modeWidget) {
        const nextMode = chooseValue(modeWidget.value, modeValues, modeValues[0]);
        changed = setWidgetValue(node, modeWidget, nextMode) || changed;
    }

    if (resolutionWidget) {
        const nextResolution = chooseValue(resolutionWidget.value, resolutionValues, AUTO_VALUE);
        changed = setWidgetValue(node, resolutionWidget, nextResolution) || changed;
    }

    if (aspectRatioWidget) {
        const nextAspectRatio = chooseValue(aspectRatioWidget.value, aspectRatioValues, AUTO_VALUE);
        changed = setWidgetValue(node, aspectRatioWidget, nextAspectRatio) || changed;
    }

    if (durationWidget) {
        const minimumDuration = modelCapabilities.minimum_duration;
        const shouldForceMinimum = options.forceMinimumDuration === true && minimumDuration;
        let nextDuration = chooseValue(durationWidget.value, durationValues, minimumDuration ?? AUTO_VALUE);

        if (shouldForceMinimum) {
            nextDuration = String(minimumDuration);
        } else {
            const currentDuration = durationWidget.value == null ? "" : String(durationWidget.value);
            const currentIsAutomatic = currentDuration === "" || currentDuration === AUTO_VALUE;
            if (currentIsAutomatic && minimumDuration && durationValues.includes(String(minimumDuration))) {
                nextDuration = String(minimumDuration);
            }
        }

        changed = setWidgetValue(node, durationWidget, nextDuration) || changed;
    }

    changed = syncEstimatedCost(node, capabilities) || changed;

    if (changed) {
        resizeNodeToVisibleWidgets(node);
    }
}

app.registerExtension({
    name: "OpenRouter.VideoControls",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_IDS.has(nodeData.name)) {
            return;
        }

        const globals = {
            modeValues: normalizeValues(nodeData.input?.required?.video_mode?.[0]),
            resolutionValues: normalizeValues(nodeData.input?.required?.video_resolution?.[0]),
            aspectRatioValues: normalizeValues(nodeData.input?.required?.video_aspect_ratio?.[0]),
            durationValues: normalizeValues(nodeData.input?.required?.duration?.[0]),
        };
        const capabilities = nodeData.input?.required?.model?.[1]?.video_capabilities ?? {};

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            configureAdvancedProviderWidget(this);
            ensureInfoWidgets(this);

            wrapWidgetCallback(this, "model", () => {
                syncVideoWidgets(this, globals, capabilities, { forceMinimumDuration: true });
            });
            for (const widgetName of ["video_mode", "video_resolution", "video_aspect_ratio", "duration", "generate_audio"]) {
                wrapWidgetCallback(this, widgetName, () => {
                    syncVideoWidgets(this, globals, capabilities);
                });
            }

            wrapWidgetCallback(this, "request_type", () => {
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                if (requestType === "video") {
                    requestAnimationFrame(() => {
                        syncVideoWidgets(this, globals, capabilities);
                    });
                } else {
                    requestAnimationFrame(() => {
                        syncEstimatedCost(this, capabilities);
                        resizeNodeToVisibleWidgets(this);
                    });
                }
            });

            requestAnimationFrame(() => {
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                if (requestType === "video") {
                    syncVideoWidgets(this, globals, capabilities);
                } else {
                    syncEstimatedCost(this, capabilities);
                    resizeNodeToVisibleWidgets(this);
                }
            });

            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                configureAdvancedProviderWidget(this);
                const requestType = String(getWidget(this, "request_type")?.value ?? "chat");
                if (requestType === "video") {
                    syncVideoWidgets(this, globals, capabilities);
                } else {
                    syncEstimatedCost(this, capabilities);
                    resizeNodeToVisibleWidgets(this);
                }
            });
        };
    },
})
