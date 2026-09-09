import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ExtensionFailedSchema } from "../src/protocol.js";

function harness(labels = ["Standard", "Extended", "Heavy", "Future depth"]) {
  const element = (text: string, attributes: Record<string, string> = {}) => ({
    innerText: text,
    visible: true,
    disabled: false,
    getAttribute: (key: string) => attributes[key] ?? null,
    hasAttribute: (key: string) => key in attributes,
    getBoundingClientRect() {
      return { width: this.visible ? 100 : 0, height: this.visible ? 30 : 0 };
    },
  });
  const attributes: Record<string, string> = {
    "aria-label": "Thinking effort",
    "aria-expanded": "false",
    "aria-controls": "depths",
  };
  const options = labels.map((label, index) =>
    element(label, { "aria-checked": String(index === 0) }),
  );
  const menu = {
    ...element(""),
    visible: false,
    querySelectorAll: (selector?: string): unknown[] =>
      selector === "[role='slider']" ? [] : options,
    dispatchEvent: () => {
      menu.visible = false;
      attributes["aria-expanded"] = "false";
    },
  };
  const control = {
    ...element("Standard", attributes),
    focus: vi.fn(),
    dispatchEvent: vi.fn<(event: unknown) => void>(),
    click: () => {
      menu.visible = !menu.visible;
      attributes["aria-expanded"] = String(menu.visible);
    },
  };
  const native = vi.fn(async (target: typeof control, _job: string, action: string) => {
    if (action === "thinking_depth_menu") control.click();
    else {
      control.innerText = target.innerText;
      menu.visible = false;
      attributes["aria-expanded"] = "false";
    }
  });
  const context = {
    activeJobId: null as string | null,
    authenticated: () => true,
    userMessages: () => [],
    SELECTORS: { composer: ["composer"], stop: ["stop"] },
    first: (selectors: string[]) => (selectors[0] === "composer" ? {} : null),
    composerControlRoot: () => ({ querySelectorAll: () => [control] }),
    document: { querySelectorAll: () => [menu], getElementById: () => menu },
    getComputedStyle: () => ({ visibility: "visible" }),
    visibleText: (target: typeof control | null) => target?.innerText ?? "",
    waitForMutation: () => Promise.resolve(),
    setTimeout,
    nativeClick: native,
    PointerEvent: class {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    },
    MouseEvent: class {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    },
    KeyboardEvent: class {
      constructor(
        public type: string,
        public options: { key: string },
      ) {}
    },
  };
  const content = readFileSync(new URL("../extension/content-script.js", import.meta.url), "utf8");
  const functions = content.slice(
    content.indexOf("let thinkingDepthDiscoveryDiagnostics"),
    content.indexOf("function buttonByText("),
  );
  const api = runInNewContext(
    `${functions}\n({ discoverThinkingDepths, configureThinkingDepth, thinkingDepthOptions, readThinkingDepthChoices })`,
    context,
  );
  return { api, context, control, menu, options, native };
}

describe("visible thinking depth menu", () => {
  it("closes both its nested menu and the parent popover without reopening either", async () => {
    const h = harness();
    const child = {
      ...h.menu,
      visible: false,
      dispatchEvent: () => {
        child.visible = false;
      },
    };
    const open = h.control.click;
    h.control.click = () => {
      open();
      child.visible = h.menu.visible;
    };
    h.context.document.querySelectorAll = () => [h.menu, child];
    await h.api.discoverThinkingDepths();
    expect(child.visible).toBe(false);
    expect(h.menu.visible).toBe(false);
  });

  it("does not activate a second gesture after click has opened the menu", async () => {
    const h = harness();
    expect((await h.api.discoverThinkingDepths())[0].webThinkingDepths).toHaveLength(4);
    expect(h.control.dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not publish a model submenu as a single thinking depth", async () => {
    const h = harness(["High", "Latest", "GPT-5.6 Sol"]);
    expect(await h.api.discoverThinkingDepths()).toEqual([]);
  });

  it("opens pointer-down triggers with one complete gesture and no message submission", async () => {
    const h = harness();
    const open = h.control.click;
    h.control.click = () => undefined;
    h.control.dispatchEvent.mockImplementation((event) => {
      if ((event as { type: string }).type === "pointerdown") open();
    });
    expect((await h.api.discoverThinkingDepths())[0].webThinkingDepths).toHaveLength(4);
    expect(
      h.control.dispatchEvent.mock.calls.map(([event]) => (event as { type: string }).type),
    ).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup"]);
    expect(h.native).not.toHaveBeenCalled();
    expect(h.menu.visible).toBe(false);
  });

  it("activates a keyboard menu when click alone does not open the real trigger", async () => {
    const h = harness();
    const open = h.control.click;
    h.control.click = () => undefined;
    h.control.dispatchEvent.mockImplementation((event) => {
      const keyEvent = event as { type: string; options: { key: string } };
      if (keyEvent.type === "keydown" && keyEvent.options.key === "Enter") open();
    });
    expect((await h.api.discoverThinkingDepths())[0].webThinkingDepths).toEqual([
      "Standard",
      "Extended",
      "Heavy",
      "Future depth",
    ]);
    expect(h.control.focus).toHaveBeenCalledOnce();
    expect(h.native).not.toHaveBeenCalled();
    expect(h.menu.visible).toBe(false);
  });

  it("discovers every enabled label, including an unknown future depth, without selecting or sending", async () => {
    const { api, control, menu, native } = harness();
    expect(await api.discoverThinkingDepths()).toMatchObject([
      {
        webThinkingDepths: ["Standard", "Extended", "Heavy", "Future depth"],
        defaultWebThinkingDepth: "Standard",
      },
    ]);
    expect(control.innerText).toBe("Standard");
    expect(menu.visible).toBe(false);
    expect(native).not.toHaveBeenCalled();
  });

  it("does not advertise disabled choices or private-looking labels", async () => {
    const { api, options } = harness(["Standard", "Extended", "user@example.test"]);
    options[1]!.disabled = true;
    expect((await api.discoverThinkingDepths())[0].webThinkingDepths).toEqual(["Standard"]);
  });

  it("never opens a menu while a task or a user-owned menu is active", async () => {
    const { api, context, menu } = harness();
    context.activeJobId = "busy";
    expect(await api.discoverThinkingDepths()).toEqual([]);
    context.activeJobId = null;
    menu.visible = true;
    expect(await api.discoverThinkingDepths()).toEqual([]);
    expect(menu.visible).toBe(true);
  });

  it("selects and verifies exactly the requested depth before any submission", async () => {
    const { api, control, native } = harness();
    await api.configureThinkingDepth({ thinkingDepth: "Heavy", jobId: "test" }, Date.now() + 5_000);
    expect(control.innerText).toBe("Heavy");
    expect(native.mock.calls.map((call) => call[2])).toEqual([
      "thinking_depth_menu",
      "thinking_depth_option",
    ]);
  });

  it("rejects an absent depth without selecting a fallback", async () => {
    const { api, control, native } = harness();
    await expect(
      api.configureThinkingDepth({ thinkingDepth: "Missing", jobId: "test" }, Date.now() + 5_000),
    ).rejects.toThrow("chatgpt_thinking_depth_unavailable");
    expect(control.innerText).toBe("Standard");
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("keeps old requests unchanged and refuses an unconfirmed selection", async () => {
    const { api, native } = harness();
    await api.configureThinkingDepth({}, Date.now() + 5_000);
    expect(native).not.toHaveBeenCalled();
    native.mockImplementation(async (_target, _job, action) => {
      if (action === "thinking_depth_menu") _target.click();
    });
    await expect(
      api.configureThinkingDepth({ thinkingDepth: "Heavy", jobId: "test" }, Date.now() + 30),
    ).rejects.toThrow("chatgpt_thinking_depth_unverified");
  });
});

function sliderHarness() {
  const h = harness();
  const labels = ["Instant", "Medium", "High", "Extra High", "6 Pro"];
  let value = 1;
  const slider = {
    getBoundingClientRect: () => ({ width: 16, height: 16 }),
    getAttribute: (key: string) =>
      ({
        "aria-valuemin": "0",
        "aria-valuemax": "4",
        "aria-valuenow": String(value),
        "aria-valuetext": labels[value],
      })[key] ?? null,
    hasAttribute: () => false,
    focus: vi.fn(),
    dispatchEvent: vi.fn((event: { type: string; options: { key: string } }) => {
      if (event.type !== "keydown") return;
      value = Math.max(0, Math.min(4, value + (event.options.key === "ArrowRight" ? 1 : -1)));
      h.control.innerText = labels[value]!;
    }),
  };
  h.menu.querySelectorAll = (selector?: string) => (selector === "[role='slider']" ? [slider] : []);
  h.control.innerText = "Medium";
  return { ...h, slider, labels, value: () => value };
}

describe("accessible thinking effort slider", () => {
  it("waits for the visible label after the slider value updates", async () => {
    const h = sliderHarness();
    const attribute = h.slider.getAttribute;
    let pendingLabel = "Medium";
    let delayLabel = false;
    const dispatch = h.slider.dispatchEvent.getMockImplementation()!;
    h.slider.dispatchEvent.mockImplementation((event) => {
      dispatch(event);
      if (event.type !== "keydown") return;
      const label = h.labels[h.value()]!;
      if (delayLabel) setTimeout(() => (pendingLabel = label), 20);
      else pendingLabel = label;
      // Discovery finishes by restoring Medium, then configuration selects High.
      if (h.value() === 1 && h.slider.dispatchEvent.mock.calls.length > 10) delayLabel = true;
    });
    h.slider.getAttribute = (key) => (key === "aria-valuetext" ? pendingLabel : attribute(key));
    h.context.waitForMutation = () => new Promise((resolve) => setTimeout(resolve, 25));
    await h.api.configureThinkingDepth(
      { thinkingDepth: "High", jobId: "test" },
      Date.now() + 5_000,
    );
    expect(delayLabel).toBe(true);
    expect(h.value()).toBe(2);
    expect(pendingLabel).toBe("High");
    expect(h.native).toHaveBeenCalledTimes(1);
  });

  it("retains a Pro badge rendered on a separate line of the slider label", async () => {
    const h = sliderHarness();
    const attribute = h.slider.getAttribute;
    h.slider.getAttribute = (key) => (key === "aria-valuetext" ? null : attribute(key));
    const option = {
      get innerText() {
        return h.labels[h.value()]!.replace("6 Pro", "6\nPro");
      },
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    h.menu.querySelectorAll = (selector) =>
      selector === "[role='slider']" ? [h.slider] : selector === "button" ? [] : [option];
    expect((await h.api.discoverThinkingDepths())[0].webThinkingDepths).toEqual(h.labels);
  });

  it("waits for the animated slider and reads its menu label when the trigger is generic", async () => {
    const h = sliderHarness();
    const attribute = h.slider.getAttribute;
    h.slider.getAttribute = (key) => (key === "aria-valuetext" ? null : attribute(key));
    const renderedAt = Date.now();
    const menuLabel = {
      get innerText() {
        return h.labels[h.value()];
      },
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    const dispatch = h.slider.dispatchEvent.getMockImplementation()!;
    h.slider.dispatchEvent.mockImplementation((event) => {
      dispatch(event);
      h.control.innerText = "Thinking effort";
    });
    h.control.innerText = "Thinking effort";
    h.menu.querySelectorAll = (selector) =>
      selector === "[role='slider']"
        ? Date.now() - renderedAt >= 100
          ? [h.slider]
          : []
        : selector === "button"
          ? []
          : [menuLabel];
    const models = await h.api.discoverThinkingDepths();
    expect(models[0].webThinkingDepths).toEqual(h.labels);
    expect(h.value()).toBe(1);
  });

  it("prefers the slider over nested model options and reads the updated composer label", async () => {
    const h = sliderHarness();
    const attribute = h.slider.getAttribute;
    h.slider.getAttribute = (key) => (key === "aria-valuetext" ? null : attribute(key));
    const modelOptions = ["Latest", "GPT-5.6 Sol", "GPT-5.5"].map((innerText) => ({
      innerText,
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      getAttribute: () => null,
      hasAttribute: () => false,
    }));
    h.menu.querySelectorAll = (selector) =>
      selector === "[role='slider']" ? [h.slider] : selector === "button" ? [] : modelOptions;
    const models = await h.api.discoverThinkingDepths();
    expect(models[0].webThinkingDepths).toEqual(h.labels);
    expect(models[0].defaultWebThinkingDepth).toBe("Medium");
    expect(h.value()).toBe(1);
  });

  it("reads all actual labels and restores the original selection without native submission", async () => {
    const h = sliderHarness();
    const models = await h.api.discoverThinkingDepths();
    expect(models[0].webThinkingDepths).toEqual(h.labels);
    expect(models[0].defaultWebThinkingDepth).toBe("Medium");
    expect(h.value()).toBe(1);
    expect(h.control.innerText).toBe("Medium");
    expect(h.menu.visible).toBe(false);
    expect(h.native).not.toHaveBeenCalled();
  });
  it.each(["Instant", "Medium", "High", "Extra High", "6 Pro"])(
    "selects and verifies %s",
    async (label) => {
      const h = sliderHarness();
      await h.api.configureThinkingDepth(
        { thinkingDepth: label, jobId: "test" },
        Date.now() + 5_000,
      );
      expect(h.control.innerText).toBe(label);
      expect(h.native.mock.calls.map((call) => call[2])).toEqual(["thinking_depth_menu"]);
      expect(h.menu.visible).toBe(false);
    },
  );
  it("does not advertise a slider that ignores keyboard changes", async () => {
    const h = sliderHarness();
    h.slider.dispatchEvent.mockImplementation(() => undefined);
    expect(await h.api.discoverThinkingDepths()).toEqual([]);
    expect(h.value()).toBe(1);
  });
  it("restores the original value after encountering an unreadable position", async () => {
    const h = sliderHarness();
    h.labels[3] = "";
    expect(await h.api.discoverThinkingDepths()).toEqual([]);
    expect(h.value()).toBe(1);
  });
  it.each(["chatgpt_thinking_depth_unavailable", "chatgpt_thinking_depth_unverified"])(
    "transports %s instead of discarding it and timing out",
    (code) => {
      expect(
        ExtensionFailedSchema.safeParse({
          type: "failed",
          jobId: "0190abcd-0000-7000-8000-000000000099",
          code,
          message: "page_execution_failed",
        }).success,
      ).toBe(true);
    },
  );
});
