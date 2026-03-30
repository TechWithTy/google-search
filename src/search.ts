import { chromium, devices, BrowserContextOptions, Browser, Page } from "playwright";
import { SearchResponse, SearchResult, CommandOptions, HtmlResponse } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";
import { url } from "inspector";

// 指纹配置接口
interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// 保存的状态文件接口
interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

const reusableBrowsers = new Map<string, Browser>();

function dropReusableBrowser(reuseBrowserKey?: string) {
  if (reuseBrowserKey) {
    reusableBrowsers.delete(reuseBrowserKey);
  }
}

const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIMEZONE = "America/Denver";
const DEFAULT_GOOGLE_DOMAIN = "https://www.google.com/ncr";

function getPreferredTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

async function waitForManualVerification(
  page: Page,
  sorryPatterns: string[],
  timeout: number,
  reason: string,
  onVerificationChallenge?: (details: {
    reason: string;
    url: string;
    verificationTimeout: number;
  }) => Promise<void> | void
) {
  const verificationTimeout = Math.max(timeout * 6, 300000);

  logger.warn(
    {
      reason,
      url: page.url(),
      verificationTimeout,
    },
    "Detected a verification challenge. This implementation does not auto-solve CAPTCHA and will wait for manual completion."
  );

  if (onVerificationChallenge) {
    try {
      await onVerificationChallenge({
        reason,
        url: page.url(),
        verificationTimeout,
      });
    } catch (error) {
      logger.warn({ error, reason }, "Failed while sending the verification challenge notification.");
    }
  }

  await page.waitForURL(
    (url) => {
      const urlStr = url.toString();
      return sorryPatterns.every((pattern) => !urlStr.includes(pattern));
    },
    { timeout: verificationTimeout }
  );

  logger.info("Verification completed, continuing...");
}

/**
 * 获取宿主机器的实际配置
 * @param userLocale 用户指定的区域设置（如果有）
 * @returns 基于宿主机器的指纹配置
 */
function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // 获取系统区域设置
  const systemLocale = userLocale || process.env.LANG || DEFAULT_LOCALE;

  // 获取系统时区
  // Node.js 不直接提供时区信息，但可以通过时区偏移量推断
  const timezoneOffset = new Date().getTimezoneOffset();
  let timezoneId = getPreferredTimezone();

  // 根据时区偏移量粗略推断时区
  // 时区偏移量是以分钟为单位，与UTC的差值，负值表示东区
  if (timezoneOffset <= -480 && timezoneOffset > -600) {
    // UTC+8 (中国、新加坡、香港等)
    timezoneId = "Asia/Shanghai";
  } else if (timezoneOffset <= -540) {
    // UTC+9 (日本、韩国等)
    timezoneId = "Asia/Tokyo";
  } else if (timezoneOffset <= -420 && timezoneOffset > -480) {
    // UTC+7 (泰国、越南等)
    timezoneId = "Asia/Bangkok";
  } else if (timezoneOffset <= 0 && timezoneOffset > -60) {
    // UTC+0 (英国等)
    timezoneId = "Europe/London";
  } else if (timezoneOffset <= 60 && timezoneOffset > 0) {
    // UTC-1 (欧洲部分地区)
    timezoneId = "Europe/Berlin";
  } else if (timezoneOffset <= 300 && timezoneOffset > 240) {
    // UTC-5 (美国东部)
    timezoneId = "America/New_York";
  }

  // 检测系统颜色方案
  // Node.js 无法直接获取系统颜色方案，使用合理的默认值
  // 可以根据时间推断：晚上使用深色模式，白天使用浅色模式
  const hour = new Date().getHours();
  const colorScheme =
    hour >= 19 || hour < 7 ? ("dark" as const) : ("light" as const);

  // 其他设置使用合理的默认值
  const reducedMotion = "no-preference" as const; // 大多数用户不会启用减少动画
  const forcedColors = "none" as const; // 大多数用户不会启用强制颜色

  // 选择一个合适的设备名称
  // 根据操作系统选择合适的浏览器
  const platform = os.platform();
  let deviceName = "Desktop Chrome"; // 默认使用Chrome

  if (platform === "darwin") {
    // macOS
    deviceName = "Desktop Safari";
  } else if (platform === "win32") {
    // Windows
    deviceName = "Desktop Edge";
  } else if (platform === "linux") {
    // Linux
    deviceName = "Desktop Firefox";
  }

  // 我们使用的Chrome
  deviceName = "Desktop Chrome";

  return {
    deviceName,
    locale: systemLocale,
    timezoneId,
    colorScheme,
    reducedMotion,
    forcedColors,
  };
}

/**
 * 执行Google搜索并返回结果
 * @param query 搜索关键词
 * @param options 搜索选项
 * @returns 搜索结果
 */
export async function googleSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  // 设置默认选项
  const {
    limit = 10,
    maxPages = 1,
    timeout = 60000,
    stateFile = "./browser-state.json",
    noSaveState = false,
    locale = DEFAULT_LOCALE,
    headless = true,
    manualVerification = false,
    googleDomain = DEFAULT_GOOGLE_DOMAIN,
    reuseBrowserKey,
    onVerificationChallenge,
  } = options;

  let useHeadless = manualVerification ? false : headless;

  logger.info({ options }, "Initializing browser...");

  // 检查是否存在状态文件
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // 指纹配置文件路径
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found a browser state file. Reusing the saved session to reduce anti-bot checks."
    );
    storageState = stateFile;

    // 尝试加载保存的指纹配置
    if (fs.existsSync(fingerprintFile)) {
      try {
        const fingerprintData = fs.readFileSync(fingerprintFile, "utf8");
        savedState = JSON.parse(fingerprintData);
        logger.info("Loaded saved browser fingerprint configuration.");
      } catch (e) {
        logger.warn({ error: e }, "Could not load the fingerprint file. Creating a new fingerprint.");
      }
    }
  } else {
    logger.info(
      { stateFile },
      "No browser state file found. Creating a new browser session and fingerprint."
    );
  }

  // 只使用桌面设备列表
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // 获取随机设备配置或使用保存的配置
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // 使用保存的设备配置
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // 随机选择一个设备
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // 获取随机延迟时间
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  const normalizeResultLink = (rawLink: string) => {
    try {
      const url = new URL(rawLink);
      url.hash = "";
      return url.toString();
    } catch {
      return String(rawLink || "").split("#")[0] || String(rawLink || "");
    }
  };

  const shouldKeepResult = (result: SearchResult) => {
    const title = String(result.title || "").trim();
    const link = String(result.link || "").trim();
    if (!title || !link) return false;
    if (/^read more$/i.test(title)) return false;
    if (/^about this result$/i.test(title)) return false;
    if (/google\.com\/|accounts\.google|support\.google/i.test(link)) return false;
    if (/#:~:text=/i.test(String(result.link || ""))) return false;
    return true;
  };

  const extractSearchResults = async (
    page: Page,
    maxResults: number
  ): Promise<SearchResult[]> => {
    return await page.evaluate((pageLimit: number): SearchResult[] => {
      const results: { title: string; link: string; snippet: string }[] = [];
      const seenUrls = new Set<string>();

      const normalizeLink = (rawLink: string) => {
        try {
          const url = new URL(rawLink);
          url.hash = "";
          return url.toString();
        } catch {
          return rawLink.split("#")[0] || rawLink;
        }
      };

      const shouldSkipResult = (title: string, link: string) => {
        const normalizedTitle = (title || "").trim();
        const normalizedLink = (link || "").trim();

        if (!normalizedLink || !normalizedLink.startsWith("http")) return true;
        if (/google\.com\/|accounts\.google|support\.google/i.test(normalizedLink)) return true;
        if (/#:~:text=/i.test(link)) return true;
        if (/^read more$/i.test(normalizedTitle)) return true;
        if (/^about this result$/i.test(normalizedTitle)) return true;

        return false;
      };

      const selectorSets = [
        { container: '#search div[data-hveid]', title: 'h3', snippet: '.VwiC3b' },
        { container: '#rso div[data-hveid]', title: 'h3', snippet: '[data-sncf="1"]' },
        { container: '.g', title: 'h3', snippet: 'div[style*="webkit-line-clamp"]' },
        { container: 'div[jscontroller][data-hveid]', title: 'h3', snippet: 'div[role="text"]' }
      ];

      const alternativeSnippetSelectors = [
        '.VwiC3b',
        '[data-sncf="1"]',
        'div[style*="webkit-line-clamp"]',
        'div[role="text"]'
      ];

      for (const selectors of selectorSets) {
        if (results.length >= pageLimit) break;

        const containers = document.querySelectorAll(selectors.container);

        for (const container of containers) {
          if (results.length >= pageLimit) break;

          const titleElement = container.querySelector(selectors.title);
          if (!titleElement) continue;

          const title = (titleElement.textContent || "").trim();

          let link = '';
          const linkInTitle = titleElement.querySelector('a');
          if (linkInTitle) {
            link = linkInTitle.href;
          } else {
            let current: Element | null = titleElement;
            while (current && current.tagName !== 'A') {
              current = current.parentElement;
            }
            if (current && current instanceof HTMLAnchorElement) {
              link = current.href;
            } else {
              const containerLink = container.querySelector('a');
              if (containerLink) {
                link = containerLink.href;
              }
            }
          }

          link = normalizeLink(link);
          if (shouldSkipResult(title, link) || seenUrls.has(link)) continue;

          let snippet = '';
          const snippetElement = container.querySelector(selectors.snippet);
          if (snippetElement) {
            snippet = (snippetElement.textContent || "").trim();
          } else {
            for (const altSelector of alternativeSnippetSelectors) {
              const element = container.querySelector(altSelector);
              if (element) {
                snippet = (element.textContent || "").trim();
                break;
              }
            }

            if (!snippet) {
              const textNodes = Array.from(container.querySelectorAll('div')).filter(el =>
                !el.querySelector('h3') &&
                (el.textContent || "").trim().length > 20
              );
              if (textNodes.length > 0) {
                snippet = (textNodes[0].textContent || "").trim();
              }
            }
          }

          if (title && link) {
              results.push({ title, link, snippet });
              seenUrls.add(link);
          }
        }
      }

      if (results.length < pageLimit) {
        const anchorElements = Array.from(document.querySelectorAll("a[href^='http']"));
        for (const el of anchorElements) {
          if (results.length >= pageLimit) break;
          if (!(el instanceof HTMLAnchorElement)) {
            continue;
          }
          const title = (el.textContent || "").trim();
          const link = normalizeLink(el.href);
          if (shouldSkipResult(title, link) || seenUrls.has(link)) {
            continue;
          }
          if (!title) continue;

          let snippet = "";
          let parent = el.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            const text = (parent.textContent || "").trim();
            if (text.length > 20 && text !== title) {
              snippet = text;
              break;
            }
            parent = parent.parentElement;
          }

          results.push({ title, link, snippet });
          seenUrls.add(link);
        }
      }

      return results.slice(0, pageLimit);
    }, maxResults);
  };

  const gotoNextResultsPage = async (page: Page): Promise<boolean> => {
    const nextSelectors = [
      '#pnnext',
      'a[aria-label="Next page"]',
      'a[aria-label="Next"]',
    ];

    for (const selector of nextSelectors) {
      const nextLink = await page.$(selector);
      if (!nextLink) continue;

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout }),
        nextLink.click(),
      ]);
      return true;
    }

    return false;
  };

  // 定义一个函数来执行搜索，可以重用于无头和有头模式
  async function performSearch(headless: boolean): Promise<SearchResponse> {
    let browser: Browser;
    let browserWasProvided = false;
    const reusableBrowser = reuseBrowserKey ? reusableBrowsers.get(reuseBrowserKey) : undefined;

    if (existingBrowser) {
      browser = existingBrowser;
      browserWasProvided = true;
      logger.info("Using provided browser instance.");
    } else if (reusableBrowser) {
      browser = reusableBrowser;
      logger.info({ reuseBrowserKey }, "Reusing browser instance from session cache.");
    } else {
      logger.info(
        { headless },
        `Preparing to launch the browser in ${headless ? "headless" : "headed"} mode...`
      );

      // 初始化浏览器，添加更多参数以避免检测
      browser = await chromium.launch({
        headless,
        timeout: timeout * 2, // 增加浏览器启动超时时间
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-web-security",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--hide-scrollbars",
          "--mute-audio",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-component-extensions-with-background-pages",
          "--disable-extensions",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--disable-renderer-backgrounding",
          "--enable-features=NetworkService,NetworkServiceInProcess",
          "--force-color-profile=srgb",
          "--metrics-recording-only",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });

      logger.info("Browser started successfully.");
      if (reuseBrowserKey) {
        reusableBrowsers.set(reuseBrowserKey, browser);
      }
    }

    // 获取设备配置 - 使用保存的或随机生成
    const [deviceName, deviceConfig] = getDeviceConfig();

    // 创建浏览器上下文选项
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // 如果有保存的指纹配置，使用它；否则使用宿主机器的实际设置
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("Using saved browser fingerprint configuration.");
    } else {
      // 获取宿主机器的实际设置
      const hostConfig = getHostMachineConfig(locale);

      // 如果需要使用不同的设备类型，重新获取设备配置
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on the host machine settings."
        );
        // 使用新的设备配置
        contextOptions = { ...devices[hostConfig.deviceName] };
      }

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // 保存新生成的指纹配置
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "Generated a new browser fingerprint from the host machine settings."
      );
    }

    // 添加通用选项 - 确保使用桌面配置
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // 强制使用桌面模式
      hasTouch: false, // 禁用触摸功能
      javaScriptEnabled: true,
    };

    if (storageState) {
      logger.info("Loading saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // 设置额外的浏览器属性以避免检测
    await context.addInitScript(() => {
      // 覆盖 navigator 属性
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => [locale, locale.split("-")[0] || "en", "en-US", "en"],
      });

      // 覆盖 window 属性
      // @ts-ignore - 忽略 chrome 属性不存在的错误
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // 添加 WebGL 指纹随机化
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // 随机化 UNMASKED_VENDOR_WEBGL 和 UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    });

    const page = await context.newPage();

    // 设置页面额外属性
    await page.addInitScript(() => {
      // 模拟真实的屏幕尺寸和颜色深度
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // 使用保存的Google域名或随机选择一个
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using saved Google domain.");
      } else {
        selectedDomain = googleDomain;
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Using configured Google domain.");
      }

      logger.info("Opening Google search page...");

      // 访问Google搜索页面
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // 检查是否被重定向到人机验证页面
      const currentUrl = page.url();
      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().toString().includes(pattern))
      );

      if (isBlockedPage) {
        if (headless) {
          logger.warn("Detected a verification page. Restarting the browser in headed mode...");

          // 关闭当前页面和上下文
          await page.close();
          await context.close();

          // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
          if (browserWasProvided) {
            logger.info(
              "Hit a verification page while using an external browser. Creating a new browser instance..."
            );
            // 创建一个新的浏览器实例，不再使用外部提供的实例
            const newBrowser = await chromium.launch({
              headless: false, // 使用有头模式
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // 其他参数与原来相同
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-site-isolation-trials",
                "--disable-web-security",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-extensions",
                "--disable-features=TranslateUI",
                "--disable-ipc-flooding-protection",
                "--disable-renderer-backgrounding",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--force-color-profile=srgb",
                "--metrics-recording-only",
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // 使用新的浏览器实例执行搜索
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // 这里可以添加处理人机验证的代码
              // ...

              // 完成后关闭临时浏览器
              await newBrowser.close();

              // 重新执行搜索
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
            dropReusableBrowser(reuseBrowserKey);
            await browser.close();
            return performSearch(false); // 以有头模式重新执行搜索
          }
        } else {
          await waitForManualVerification(page, sorryPatterns, timeout, "initial-page", onVerificationChallenge);
        }
      }

      logger.info({ query }, "Entering search query.");

      // 等待搜索框出现 - 尝试多个可能的选择器
      const searchInputSelectors = [
        "textarea[name='q']",
        "input[name='q']",
        "textarea[title='Search']",
        "input[title='Search']",
        "textarea[aria-label='Search']",
        "input[aria-label='Search']",
        "textarea",
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          logger.info({ selector }, "Found search box.");
          break;
        }
      }

      if (!searchInput) {
        logger.error("Could not find the search box.");
        throw new Error("Could not find the search box.");
      }

      // 直接点击搜索框，减少延迟
      await searchInput.click();

      // 直接输入整个查询字符串，而不是逐个字符输入
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // 减少按回车前的延迟
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for the page to finish loading...");

      // 等待页面加载完成
      await page.waitForLoadState("networkidle", { timeout });

      // 检查搜索后的URL是否被重定向到人机验证页面
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn(
            "Detected a verification page after submitting the search. Restarting the browser in headed mode..."
          );

          // 关闭当前页面和上下文
          await page.close();
          await context.close();

          // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
          if (browserWasProvided) {
            logger.info(
              "Hit a verification page after search while using an external browser. Creating a new browser instance..."
            );
            // 创建一个新的浏览器实例，不再使用外部提供的实例
            const newBrowser = await chromium.launch({
              headless: false, // 使用有头模式
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // 其他参数与原来相同
                "--disable-features=IsolateOrigins,site-per-process",
                "--disable-site-isolation-trials",
                "--disable-web-security",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-extensions",
                "--disable-features=TranslateUI",
                "--disable-ipc-flooding-protection",
                "--disable-renderer-backgrounding",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--force-color-profile=srgb",
                "--metrics-recording-only",
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // 使用新的浏览器实例执行搜索
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // 这里可以添加处理人机验证的代码
              // ...

              // 完成后关闭临时浏览器
              await newBrowser.close();

              // 重新执行搜索
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
            dropReusableBrowser(reuseBrowserKey);
            await browser.close();
            return performSearch(false); // 以有头模式重新执行搜索
          }
        } else {
          await waitForManualVerification(page, sorryPatterns, timeout, "after-search", onVerificationChallenge);

          // 等待页面重新加载
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      logger.info({ url: page.url() }, "Waiting for search results to load...");

      // 尝试多个可能的搜索结果选择器
      const searchResultSelectors = [
        "#search",
        "#rso",
        ".g",
        "[data-sokoban-container]",
        "div[role='main']",
      ];

      let resultsFound = false;
      for (const selector of searchResultSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: timeout / 2 });
          logger.info({ selector }, "Found search results container.");
          resultsFound = true;
          break;
        } catch (e) {
          // 继续尝试下一个选择器
        }
      }

      if (!resultsFound) {
        // 如果找不到搜索结果，检查是否被重定向到人机验证页面
        const currentUrl = page.url();
        const isBlockedDuringResults = sorryPatterns.some((pattern) =>
          currentUrl.includes(pattern)
        );

        if (isBlockedDuringResults) {
          if (headless) {
            logger.warn(
              "Detected a verification page while waiting for search results. Restarting the browser in headed mode..."
            );

            // 关闭当前页面和上下文
            await page.close();
            await context.close();

            // 如果是外部提供的浏览器，不关闭它，而是创建一个新的浏览器实例
            if (browserWasProvided) {
              logger.info(
                "使用外部浏览器实例时等待搜索结果遇到人机验证，创建新的浏览器实例..."
              );
              // 创建一个新的浏览器实例，不再使用外部提供的实例
              const newBrowser = await chromium.launch({
                headless: false, // 使用有头模式
                timeout: timeout * 2,
                args: [
                  "--disable-blink-features=AutomationControlled",
                  // 其他参数与原来相同
                  "--disable-features=IsolateOrigins,site-per-process",
                  "--disable-site-isolation-trials",
                  "--disable-web-security",
                  "--no-sandbox",
                  "--disable-setuid-sandbox",
                  "--disable-dev-shm-usage",
                  "--disable-accelerated-2d-canvas",
                  "--no-first-run",
                  "--no-zygote",
                  "--disable-gpu",
                  "--hide-scrollbars",
                  "--mute-audio",
                  "--disable-background-networking",
                  "--disable-background-timer-throttling",
                  "--disable-backgrounding-occluded-windows",
                  "--disable-breakpad",
                  "--disable-component-extensions-with-background-pages",
                  "--disable-extensions",
                  "--disable-features=TranslateUI",
                  "--disable-ipc-flooding-protection",
                  "--disable-renderer-backgrounding",
                  "--enable-features=NetworkService,NetworkServiceInProcess",
                  "--force-color-profile=srgb",
                  "--metrics-recording-only",
                ],
                ignoreDefaultArgs: ["--enable-automation"],
              });

              // 使用新的浏览器实例执行搜索
              try {
                const tempContext = await newBrowser.newContext(contextOptions);
                const tempPage = await tempContext.newPage();

                // 这里可以添加处理人机验证的代码
                // ...

                // 完成后关闭临时浏览器
                await newBrowser.close();

                // 重新执行搜索
                return performSearch(false);
              } catch (error) {
                await newBrowser.close();
                throw error;
              }
            } else {
              // 如果不是外部提供的浏览器，直接关闭并重新执行搜索
              dropReusableBrowser(reuseBrowserKey);
              await browser.close();
              return performSearch(false); // 以有头模式重新执行搜索
            }
          } else {
            await waitForManualVerification(page, sorryPatterns, timeout, "results-page", onVerificationChallenge);

            // 再次尝试等待搜索结果
            for (const selector of searchResultSelectors) {
              try {
                await page.waitForSelector(selector, { timeout: timeout / 2 });
                logger.info({ selector }, "验证后找到搜索结果");
                resultsFound = true;
                break;
              } catch (e) {
                // 继续尝试下一个选择器
              }
            }

            if (!resultsFound) {
              logger.error("无法找到搜索结果元素");
              throw new Error("无法找到搜索结果元素");
            }
          }
        } else {
          // 如果不是人机验证问题，则抛出错误
          logger.error("无法找到搜索结果元素");
          throw new Error("无法找到搜索结果元素");
        }
      }

      // 减少等待时间
      await page.waitForTimeout(getRandomDelay(200, 500));

      logger.info("Extracting search results...");

      const requestedPages = Math.max(1, Math.floor(maxPages || 1));
      const aggregatedResults: SearchResult[] = [];
      const seenLinks = new Set<string>();

      for (let pageIndex = 0; pageIndex < requestedPages; pageIndex += 1) {
        const remaining = Math.max(limit - aggregatedResults.length, 0);
        if (remaining === 0) {
          break;
        }

        const pageResults = await extractSearchResults(page, remaining);
        for (const rawResult of pageResults) {
          const result = {
            ...rawResult,
            title: String(rawResult.title || "").trim(),
            link: normalizeResultLink(rawResult.link || ""),
            snippet: String(rawResult.snippet || "").trim(),
          };

          if (!shouldKeepResult(result) || seenLinks.has(result.link)) continue;
          seenLinks.add(result.link);
          aggregatedResults.push(result);
          if (aggregatedResults.length >= limit) break;
        }

        if (aggregatedResults.length >= limit || pageIndex >= requestedPages - 1) {
          break;
        }

        logger.info(
          { currentPage: pageIndex + 1, requestedPages, collected: aggregatedResults.length },
          "Moving to the next Google results page..."
        );

        const moved = await gotoNextResultsPage(page);
        if (!moved) {
          logger.info({ currentPage: pageIndex + 1 }, "No next results page found.");
          break;
        }

        await page.waitForTimeout(getRandomDelay(250, 600));
      }

      const results = aggregatedResults.slice(0, limit);

      logger.info({ count: results.length }, "Retrieved search results successfully.");

      try {
        // 保存浏览器状态（除非用户指定了不保存）
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");

          // 确保目录存在
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // 保存状态
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully.");

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved.");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Failed while saving fingerprint configuration.");
          }
        } else {
          logger.info("Skipping browser state save because it was disabled by configuration.");
        }
      } catch (error) {
        logger.error({ error }, "Failed while saving browser state.");
      }

      // 只有在浏览器不是外部提供的情况下才关闭浏览器
      if (!browserWasProvided && !reuseBrowserKey) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open for reuse.");
      }

      // 返回搜索结果
      return {
        query,
        results, // 现在 results 在这个作用域内是可访问的
      };
    } catch (error) {
      logger.error({ error }, "搜索过程中发生错误");

      try {
        // 尝试保存浏览器状态，即使发生错误
        if (!noSaveState) {
          logger.info({ stateFile }, "正在保存浏览器状态...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "指纹配置已保存");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "保存指纹配置时发生错误");
          }
        }
      } catch (stateError) {
        logger.error({ error: stateError }, "保存浏览器状态时发生错误");
      }

      // 只有在浏览器不是外部提供的情况下才关闭浏览器
      if (!browserWasProvided && !reuseBrowserKey) {
        logger.info("Closing browser...");
        await browser.close();
      } else {
        logger.info("Keeping browser instance open for reuse.");
      }

      // 返回错误信息或空结果
      // logger.error 已经记录了错误，这里返回一个包含错误信息的模拟结果
       return {
         query,
         results: [
           {
             title: "Search failed",
             link: "",
             snippet: `Could not complete search. Error: ${
               error instanceof Error ? error.message : String(error)
             }`,
           },
         ],
       };
    }
    // 移除 finally 块，因为资源清理已经在 try 和 catch 块中处理
  }

  // 首先尝试以无头模式执行搜索
  return performSearch(useHeadless);
}

export async function closeReusableGoogleSearchBrowser(reuseBrowserKey: string) {
  const browser = reusableBrowsers.get(reuseBrowserKey);
  if (!browser) {
    return false;
  }

  reusableBrowsers.delete(reuseBrowserKey);
  try {
    await browser.close();
  } catch (error) {
    logger.warn({ error, reuseBrowserKey }, "Failed to close reusable browser cleanly.");
  }
  return true;
}

/**
 * 获取Google搜索结果页面的原始HTML
 * @param query 搜索关键词
 * @param options 搜索选项
 * @param saveToFile 是否将HTML保存到文件（可选）
 * @param outputPath HTML输出文件路径（可选，默认为'./google-search-html/[query]-[timestamp].html'）
 * @returns 包含HTML内容的响应对象
 */
export async function getGoogleSearchPageHtml(
  query: string,
  options: CommandOptions = {},
  saveToFile: boolean = false,
  outputPath?: string
): Promise<HtmlResponse> {
  // 设置默认选项，与googleSearch保持一致
  const {
    timeout = 60000,
    stateFile = "./browser-state.json",
    noSaveState = false,
    locale = DEFAULT_LOCALE,
    headless = true,
    manualVerification = false,
    googleDomain = DEFAULT_GOOGLE_DOMAIN,
    onVerificationChallenge,
  } = options;

  let useHeadless = manualVerification ? false : headless;

  logger.info({ options }, "Initializing browser to fetch search result page HTML...");

  // 复用googleSearch中的浏览器初始化代码
  // 检查是否存在状态文件
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // 指纹配置文件路径
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found a browser state file. Reusing the saved session to reduce anti-bot checks."
    );
    storageState = stateFile;

    // 尝试加载保存的指纹配置
    if (fs.existsSync(fingerprintFile)) {
      try {
        const fingerprintData = fs.readFileSync(fingerprintFile, "utf8");
        savedState = JSON.parse(fingerprintData);
        logger.info("Loaded saved browser fingerprint configuration.");
      } catch (e) {
        logger.warn({ error: e }, "Could not load the fingerprint file. Creating a new fingerprint.");
      }
    }
  } else {
    logger.info(
      { stateFile },
      "No browser state file found. Creating a new browser session and fingerprint."
    );
  }

  // 只使用桌面设备列表
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // 获取随机设备配置或使用保存的配置
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // 使用保存的设备配置
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // 随机选择一个设备
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // 获取随机延迟时间
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // 定义一个专门的函数来获取HTML
  async function performSearchAndGetHtml(headless: boolean): Promise<HtmlResponse> {
    let browser: Browser;
    
    // 初始化浏览器，添加更多参数以避免检测
    browser = await chromium.launch({
      headless,
      timeout: timeout * 2, // 增加浏览器启动超时时间
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--disable-web-security",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-extensions-with-background-pages",
        "--disable-extensions",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
        "--disable-renderer-backgrounding",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    logger.info("Browser started successfully.");

    // 获取设备配置 - 使用保存的或随机生成
    const [deviceName, deviceConfig] = getDeviceConfig();

    // 创建浏览器上下文选项
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // 如果有保存的指纹配置，使用它；否则使用宿主机器的实际设置
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("Using saved browser fingerprint configuration.");
    } else {
      // 获取宿主机器的实际设置
      const hostConfig = getHostMachineConfig(locale);

      // 如果需要使用不同的设备类型，重新获取设备配置
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on the host machine settings."
        );
        // 使用新的设备配置
        contextOptions = { ...devices[hostConfig.deviceName] };
      }

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // 保存新生成的指纹配置
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "Generated a new browser fingerprint from the host machine settings."
      );
    }

    // 添加通用选项 - 确保使用桌面配置
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // 强制使用桌面模式
      hasTouch: false, // 禁用触摸功能
      javaScriptEnabled: true,
    };

    if (storageState) {
      logger.info("Loading saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // 设置额外的浏览器属性以避免检测
    await context.addInitScript(() => {
      // 覆盖 navigator 属性
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => [locale, locale.split("-")[0] || "en", "en-US", "en"],
      });

      // 覆盖 window 属性
      // @ts-ignore - 忽略 chrome 属性不存在的错误
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // 添加 WebGL 指纹随机化
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // 随机化 UNMASKED_VENDOR_WEBGL 和 UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    });

    const page = await context.newPage();

    // 设置页面额外属性
    await page.addInitScript(() => {
      // 模拟真实的屏幕尺寸和颜色深度
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // 使用保存的Google域名或随机选择一个
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using saved Google domain.");
      } else {
        selectedDomain = googleDomain;
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Using configured Google domain.");
      }

      logger.info("Opening Google search page...");

      // 访问Google搜索页面
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // 检查是否被重定向到人机验证页面
      const currentUrl = page.url();
      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().toString().includes(pattern))
      );

      if (isBlockedPage) {
        if (headless) {
          logger.warn("Detected a verification page. Restarting the browser in headed mode...");

          // 关闭当前页面和上下文
          await page.close();
          await context.close();
          await browser.close();
          
          // 以有头模式重新执行
          return performSearchAndGetHtml(false);
        } else {
          await waitForManualVerification(page, sorryPatterns, timeout, "html-initial-page", onVerificationChallenge);
        }
      }

      logger.info({ query }, "Entering search query.");

      // 等待搜索框出现 - 尝试多个可能的选择器
      const searchInputSelectors = [
        "textarea[name='q']",
        "input[name='q']",
        "textarea[title='Search']",
        "input[title='Search']",
        "textarea[aria-label='Search']",
        "input[aria-label='Search']",
        "textarea",
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          logger.info({ selector }, "Found search box.");
          break;
        }
      }

      if (!searchInput) {
        logger.error("Could not find the search box.");
        throw new Error("Could not find the search box.");
      }

      // 直接点击搜索框，减少延迟
      await searchInput.click();

      // 直接输入整个查询字符串，而不是逐个字符输入
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // 减少按回车前的延迟
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for the search results page to finish loading...");

      // 等待页面加载完成
      await page.waitForLoadState("networkidle", { timeout });

      // 检查搜索后的URL是否被重定向到人机验证页面
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn("Detected a verification page after submitting the search. Restarting the browser in headed mode...");

          // 关闭当前页面和上下文
          await page.close();
          await context.close();
          await browser.close();
          
          // 以有头模式重新执行
          return performSearchAndGetHtml(false);
        } else {
          await waitForManualVerification(page, sorryPatterns, timeout, "html-after-search", onVerificationChallenge);

          // 等待页面重新加载
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      // 获取当前页面URL
      const finalUrl = page.url();
      logger.info({ url: finalUrl }, "Search results page loaded. Preparing to extract HTML...");

      // 添加额外的等待时间，确保页面完全加载和稳定
      logger.info("Waiting for the page to stabilize...");
      await page.waitForTimeout(1000); // 等待1秒，让页面完全稳定
      
      // 再次等待网络空闲，确保所有异步操作完成
      await page.waitForLoadState("networkidle", { timeout });
      
      // 获取页面HTML内容
      const fullHtml = await page.content();
      
      // 移除CSS和JavaScript内容，只保留纯HTML
      // 移除所有<style>标签及其内容
      let html = fullHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      // 移除所有<link rel="stylesheet">标签
      html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, '');
      // 移除所有<script>标签及其内容
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      
      logger.info({
        originalLength: fullHtml.length,
        cleanedLength: html.length
      }, "Retrieved and cleaned page HTML successfully.");

      // 如果需要，将HTML保存到文件并截图
      let savedFilePath: string | undefined = undefined;
      let screenshotPath: string | undefined = undefined;
      
      if (saveToFile) {
        // 生成默认文件名（如果未提供）
        if (!outputPath) {
          // 确保目录存在
          const outputDir = "./google-search-html";
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          // 生成文件名：查询词-时间戳.html
          const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
          const sanitizedQuery = query.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
          outputPath = `${outputDir}/${sanitizedQuery}-${timestamp}.html`;
        }

        // 确保文件目录存在
        const fileDir = path.dirname(outputPath);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }

        // 写入HTML文件
        fs.writeFileSync(outputPath, html, "utf8");
        savedFilePath = outputPath;
        logger.info({ path: outputPath }, "Saved cleaned HTML content to file.");
        
        // 保存网页截图
        // 生成截图文件名（基于HTML文件名，但扩展名为.png）
        const screenshotFilePath = outputPath.replace(/\.html$/, '.png');
        
        // 截取整个页面的截图
        logger.info("Capturing page screenshot...");
        await page.screenshot({
          path: screenshotFilePath,
          fullPage: true
        });
        
        screenshotPath = screenshotFilePath;
        logger.info({ path: screenshotFilePath }, "Saved page screenshot.");
      }

      try {
        // 保存浏览器状态（除非用户指定了不保存）
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");

          // 确保目录存在
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // 保存状态
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully.");

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved.");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Failed while saving fingerprint configuration.");
          }
        } else {
          logger.info("Skipping browser state save because it was disabled by configuration.");
        }
      } catch (error) {
        logger.error({ error }, "Failed while saving browser state.");
      }

      // 关闭浏览器
      logger.info("Closing browser...");
      await browser.close();

      // 返回HTML响应
      return {
        query,
        html,
        url: finalUrl,
        savedPath: savedFilePath,
        screenshotPath: screenshotPath,
        originalHtmlLength: fullHtml.length
      };
    } catch (error) {
      logger.error({ error }, "An error occurred while fetching page HTML.");

      try {
        // 尝试保存浏览器状态，即使发生错误
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving browser state...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // 保存指纹配置
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved.");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Failed while saving fingerprint configuration.");
          }
        }
      } catch (stateError) {
        logger.error({ error: stateError }, "Failed while saving browser state.");
      }

      // 关闭浏览器
      logger.info("Closing browser...");
      await browser.close();

      // 返回错误信息
      throw new Error(`Failed to fetch Google search page HTML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 首先尝试以无头模式执行
  return performSearchAndGetHtml(useHeadless);
}
