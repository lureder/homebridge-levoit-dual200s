import axios, { AxiosInstance } from 'axios';
import { Logger, PlatformConfig } from 'homebridge';
import AsyncLock from 'async-lock';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import DebugMode from '../debugMode';
import VeSyncFan from './VeSyncFan';

/**
 * VeSync API bypass methods for device control.
 */
export enum BypassMethod {
  STATUS = 'getHumidifierStatus',
  MODE = 'setHumidityMode',
  NIGHT_LIGHT_BRIGHTNESS = 'setNightLightBrightness',
  DISPLAY = 'setDisplay',
  SWITCH = 'setSwitch',
  HUMIDITY = 'setTargetHumidity',
  MIST_LEVEL = 'setVirtualLevel',
  LEVEL = 'setLevel',
  LIGHT_STATUS = 'setLightStatus',
}

const US_HOST = 'https://smartapi.vesync.com';
const EU_HOST = 'https://smartapi.vesync.eu';
const ACCOUNT_HOST = 'https://accountapi.vesync.com';

const DEVICE_OFFLINE_MSG = 'device offline';

export const DEVICE_UNREACHABLE_ERROR =
  'Device was unreachable. Ensure it is plugged in and connected to WiFi.';

const QUOTA_EXCEEDED_CODE = -16906086;
const TOKEN_EXPIRED_CODE = -11001022;

const EU_COUNTRY_CODES = new Set<string>([
  'AL',
  'AD',
  'AT',
  'BY',
  'BE',
  'BA',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IS',
  'IE',
  'IT',
  'LV',
  'LI',
  'LT',
  'LU',
  'MT',
  'MD',
  'MC',
  'ME',
  'NL',
  'MK',
  'NO',
  'PL',
  'PT',
  'RO',
  'RU',
  'SM',
  'RS',
  'SK',
  'SI',
  'ES',
  'SE',
  'CH',
  'TR',
  'UA',
  'GB',
  'UK',
]);

function initialHostForCountry(cc: string): string {
  const upper = (cc || '').toUpperCase();
  return EU_COUNTRY_CODES.has(upper) ? EU_HOST : US_HOST;
}

const lock = new AsyncLock();

function decodeJwtTimestamps(token: string): { iat?: number; exp?: number } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return {};
    }

    const part = parts[1];
    if (!part) {
      return {};
    }

    const payload = part
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=');

    const json = Buffer.from(payload, 'base64').toString('utf8');
    const obj = JSON.parse(json);

    return { iat: obj.iat, exp: obj.exp };
  } catch {
    return {};
  }
}

interface SessionData {
  token: string;
  accountId: string;
  countryCode: string;
  baseURL?: string;
  apiBaseUrl?: string;
  region?: string;
  username?: string;
  issuedAt?: number | null;
  expiresAt?: number | null;
  lastValidatedAt: number;
}

interface LoginResponse {
  code?: number;
  msg?: string;
  result?: {
    token?: string;
    accountID?: string;
    countryCode?: string;
    bizToken?: string;
    currentRegion?: string;
  };
}

interface DeviceResult {
  humidity?: number;
  targetHumidity?: number;
  screenSwitch?: boolean;
  workMode?: string;
  powerSwitch?: number;
  autoStopState?: boolean;
  virtualLevel?: number;
  configuration?: {
    auto_target_humidity?: number;
  };
  display?: boolean;
  mode?: string;
  enabled?: boolean;
  automatic_stop_reach_target?: boolean;
  mist_virtual_level?: number;
  warm_level?: number;
  warm_enabled?: boolean;
  night_light_brightness?: number;
  water_lacks?: boolean;
  water_tank_lifted?: boolean;
  temperature?: number;
  filter_life?: number;
  rgbNightLight?: {
    brightness?: number;
    action?: string;
    blue?: number;
    green?: number;
    red?: number;
    colorMode?: string;
    speed?: number;
    colorSliderLocation?: number;
  };
}

interface DeviceInfoResponse {
  result?: {
    result?: DeviceResult;
  };
  msg?: string;
  code?: number;
}

export default class VeSync {
  private api?: AxiosInstance;
  private accountId?: string;
  private token?: string;
  private baseURL: string;
  private countryCode: string;
  private region?: string;

  private readonly VERSION = '5.6.60';
  private readonly FULL_VERSION = `VeSync ${this.VERSION}`;
  private readonly AGENT = `VeSync/${this.VERSION} (iPhone; iOS 17.2.1; Humidifier/5.00)`;
  private readonly TIMEZONE = 'America/New_York';
  private readonly OS = 'iOS 17.2.1';
  private readonly BRAND = 'iPhone 15 Pro';
  private readonly LANG = 'en';

  private readonly terminalId = '2' + uuidv4().replaceAll('-', '');
  private readonly appID = Math.random().toString(36).substring(2, 10);

  private lastLoginAttempt = 0;
  private loginBackoffMs = 10000;
  private readonly sessionFilePath?: string;
  private readonly TOKEN_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

  private readonly BYPASS_HEADER_UA = 'okhttp/3.12.1';
  private readonly AUTH_APP_VERSION = '5.7.16';
  private readonly AUTH_CLIENT_VERSION = `VeSync ${this.AUTH_APP_VERSION}`;
  private readonly AUTH_CLIENT_INFO = 'SM N9005';
  private readonly AUTH_OS_INFO = 'Android';

  constructor(
    private readonly email: string,
    private readonly password: string,
    readonly config: PlatformConfig,
    public readonly debugMode: DebugMode,
    public readonly log: Logger,
    sessionPath?: string,
  ) {
    const cc = (config.options?.countryCode || 'US').toUpperCase();
    this.countryCode = cc;
    this.baseURL = initialHostForCountry(cc);

    this.sessionFilePath =
      sessionPath ||
      path.join(process.cwd(), 'vesync-session.json');

    this.debugMode.debug(
      '[CONFIG]',
      `countryCode=${cc}, initialBaseURL=${this.baseURL}, sessionFile=${this.sessionFilePath}`,
    );
  }

  private AXIOS_OPTIONS() {
    return {
      baseURL: this.baseURL,
      timeout: this.config.options?.apiTimeout || 15000,
    };
  }

  private AUTH_AXIOS_OPTIONS(host?: string) {
    return {
      baseURL: host ?? this.baseURL,
      timeout: this.config.options?.apiTimeout || 15000,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': this.BYPASS_HEADER_UA,
        'accept-language': this.LANG,
        appVersion: this.AUTH_APP_VERSION,
        clientVersion: this.AUTH_CLIENT_VERSION,
      },
    };
  }

  private generateDetailBody() {
    return {
      appVersion: this.FULL_VERSION,
      phoneBrand: this.BRAND,
      traceId: `APP${Date.now()}-00001`,
      phoneOS: this.OS,
    };
  }

  private generateBody(includeAuth = false) {
    return {
      acceptLanguage: this.LANG,
      timeZone: this.TIMEZONE,
      ...(includeAuth
        ? {
            accountID: this.accountId,
            token: this.token,
          }
        : {}),
    };
  }

  private generateV2Body(fan: VeSyncFan, method: BypassMethod, data = {}) {
    return {
      method: 'bypassV2',
      debugMode: false,
      deviceRegion: fan.region,
      cid: fan.cid,
      configModule: fan.configModule,
      payload: {
        data: {
          ...data,
        },
        method,
        source: 'APP',
      },
    };
  }

  private generateAuthTraceId(): string {
    return `APP${this.appID}${Math.floor(Date.now() / 1000)}`;
  }

  private async loadSessionFromDisk(): Promise<SessionData | null> {
    if (!this.sessionFilePath) {
      return null;
    }

    try {
      const raw = await fs.promises.readFile(this.sessionFilePath, 'utf8');
      const session = JSON.parse(raw) as SessionData;

      const persistedBaseURL = session.apiBaseUrl || session.baseURL;

      if (!session.token || !session.accountId || !persistedBaseURL) {
        this.debugMode.debug(
          '[SESSION]',
          'Session file missing required fields, ignoring.',
        );
        return null;
      }

      if (session.username && session.username !== this.email) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted session is for a different account; ignoring.',
        );
        return null;
      }

      const now = Date.now();
      const { iat, exp } = decodeJwtTimestamps(session.token);

      if (exp && exp * 1000 <= now) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted token is expired, ignoring.',
        );
        return null;
      }

      const issuedMs = session.issuedAt ?? (iat ? iat * 1000 : now);
      if (now - issuedMs > this.TOKEN_MAX_AGE_MS * 1.5) {
        this.debugMode.debug(
          '[SESSION]',
          'Persisted token appears too old, ignoring.',
        );
        return null;
      }

      session.baseURL = persistedBaseURL;
      this.debugMode.debug('[SESSION]', 'Loaded persisted session from disk.');
      return session;
    } catch (e: unknown) {
      const error = e as { code?: string };
      if (error.code !== 'ENOENT') {
        this.debugMode.debug(
          '[SESSION]',
          'Failed to load session from disk:',
          String(e),
        );
      }
      return null;
    }
  }

  private async saveSessionToDisk(): Promise<void> {
    if (!this.sessionFilePath || !this.token || !this.accountId) {
      return;
    }

    try {
      const { iat, exp } = decodeJwtTimestamps(this.token);
      const session: SessionData = {
        token: this.token,
        accountId: this.accountId,
        countryCode: this.countryCode,
        apiBaseUrl: this.baseURL,
        baseURL: this.baseURL,
        region: this.region,
        username: this.email,
        issuedAt: iat ?? null,
        expiresAt: exp ?? null,
        lastValidatedAt: Date.now(),
      };

      await fs.promises.writeFile(
        this.sessionFilePath,
        JSON.stringify(session, null, 2),
        'utf8',
      );
      this.debugMode.debug('[SESSION]', 'Persisted VeSync session to disk.');
    } catch (e) {
      this.debugMode.debug(
        '[SESSION]',
        'Failed to save session to disk:',
        String(e),
      );
    }
  }

  private isTokenValid(): boolean {
    if (!this.token) {
      return false;
    }

    const now = Date.now();
    const { iat, exp } = decodeJwtTimestamps(this.token);

    if (exp && exp * 1000 <= now) {
      this.debugMode.debug(
        '[TOKEN]',
        'Token expired according to JWT exp claim',
      );
      return false;
    }

    if (!exp) {
      const issuedMs = iat ? iat * 1000 : now - this.TOKEN_MAX_AGE_MS;
      if (now - issuedMs > this.TOKEN_MAX_AGE_MS) {
        this.debugMode.debug('[TOKEN]', 'Token appears too old (no exp claim)');
        return false;
      }
    }

    return true;
  }

  private buildApiClient() {
    if (!this.token || !this.accountId) {
      throw new Error('Cannot build API client without token/accountId');
    }

    this.api = axios.create({
      ...this.AXIOS_OPTIONS(),
      headers: {
        'content-type': 'application/json',
        'accept-language': this.LANG,
        accountid: this.accountId,
        'user-agent': this.AGENT,
        appversion: this.FULL_VERSION,
        tz: this.TIMEZONE,
        tk: this.token,
      },
    });

    this.api.interceptors.response.use(
      (resp) => {
        if (resp.status === 200 && resp.data?.code === TOKEN_EXPIRED_CODE) {
          const error = new Error('Token expired') as Error & {
            response?: unknown;
            config?: unknown;
            isTokenExpired?: boolean;
          };
          error.response = resp;
          error.config = resp.config;
          error.isTokenExpired = true;
          return Promise.reject(error);
        }
        return resp;
      },
      async (err: any) => {
        const isTokenError =
          err?.response?.status === 401 ||
          err?.response?.status === 419 ||
          err?.response?.data?.code === TOKEN_EXPIRED_CODE ||
          err?.isTokenExpired;

        if (isTokenError) {
          if (err.config?._retryAttempted) {
            this.log.error(
              'Token refresh failed after retry. Authentication may be broken.',
            );
            throw err;
          }

          this.debugMode.debug(
            '[AUTH]',
            'Token error detected, re-authenticating…',
          );
          const ok = await this.login();
          if (ok && err.config && this.api) {
            err.config._retryAttempted = true;
            err.config.headers = err.config.headers || {};
            err.config.headers.tk = this.token!;
            err.config.headers.accountid = this.accountId!;
            return this.api.request(err.config);
          }
        }

        throw err;
      },
    );
  }

  private handleDeviceOffline<T>(
    responseMsg: string | undefined,
    returnValue: T,
  ): T | undefined {
    if (responseMsg === DEVICE_OFFLINE_MSG) {
      this.log.error(
        'VeSync cannot communicate with humidifier! Check the VeSync App.',
      );
      if (this.config.options?.showOffWhenDisconnected) {
        return returnValue;
      }
      throw new Error(DEVICE_UNREACHABLE_ERROR);
    }

    return undefined;
  }

  private handleQuotaExceeded(
    responseCode: number | undefined,
    responseMsg: string | undefined,
  ): boolean {
    if (responseCode === QUOTA_EXCEEDED_CODE) {
      this.log.warn(
        'VeSync API daily quota exceeded. The quota formula is "3200 + 1500 * user owned device number".',
      );
      this.log.warn(
        'Polling frequency has been reduced to 30 seconds. Quota resets daily.',
      );
      if (responseMsg) {
        this.debugMode.debug('[QUOTA]', responseMsg);
      }
      return true;
    }

    return false;
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.isTokenValid()) {
      this.debugMode.debug(
        '[TOKEN]',
        'Token invalid, refreshing before API call',
      );
      const ok = await this.login();
      if (!ok) {
        throw new Error('Failed to refresh expired token');
      }
      if (!this.api) {
        throw new Error('API client not available after token refresh');
      }
    }
  }

  public async sendCommand(
    fan: VeSyncFan,
    method: BypassMethod,
    body = {},
  ): Promise<boolean> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        throw new Error('The user is not logged in!');
      }

      await this.ensureValidToken();

      this.debugMode.debug(
        '[SEND COMMAND]',
        `Sending command ${method} to ${fan.name}`,
        `with (${JSON.stringify(body)})...`,
      );

      const response = await this.api.put('cloud/v2/deviceManaged/bypassV2', {
        ...this.generateV2Body(fan, method, body),
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      const offlineResult = this.handleDeviceOffline(response.data?.msg, false);
      if (offlineResult !== undefined) {
        return offlineResult;
      }

      const isSuccess = response?.data?.code === 0;

      if (isSuccess) {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Successfully sent command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response.data)}`,
        );
      } else {
        this.debugMode.debug(
          '[SEND COMMAND]',
          `Failed to send command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})!`,
          `Response: ${JSON.stringify(response?.data)}`,
        );
      }

      return isSuccess;
    });
  }

  public async getDeviceInfo(
    fan: VeSyncFan,
  ): Promise<DeviceInfoResponse | null> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        throw new Error('The user is not logged in!');
      }

      await this.ensureValidToken();

      this.debugMode.debug('[GET DEVICE INFO]', 'Getting device info...');

      const response = await this.api.post('cloud/v2/deviceManaged/bypassV2', {
        ...this.generateV2Body(fan, BypassMethod.STATUS),
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      this.debugMode.debug('[DEVICE INFO]', JSON.stringify(response.data));

      if (this.handleQuotaExceeded(response.data?.code, response.data?.msg)) {
        return null;
      }

      const offlineResult = this.handleDeviceOffline(response.data?.msg, null);
      if (offlineResult !== undefined) {
        return offlineResult;
      }

      return response.data;
    });
  }

  public async startSession(): Promise<boolean> {
    this.debugMode.debug('[START SESSION]', 'Starting auth session…');

    const session = await this.loadSessionFromDisk();
    if (session) {
      this.debugMode.debug('[SESSION]', 'Reusing persisted VeSync session.');
      this.token = session.token;
      this.accountId = session.accountId;
      this.countryCode = (
        session.countryCode ||
        this.countryCode ||
        'US'
      ).toUpperCase();

      const persistedBaseURL = session.apiBaseUrl || session.baseURL;
      this.baseURL = persistedBaseURL || this.baseURL;

      if (session.region) {
        this.region = String(session.region).toUpperCase();
      }

      try {
        this.buildApiClient();
        return true;
      } catch (e) {
        this.debugMode.debug(
          '[SESSION]',
          'Failed to hydrate persisted session, falling back to fresh login:',
          String(e),
        );
      }
    } else {
      this.debugMode.debug(
        '[SESSION]',
        'No valid persisted session found; logging in.',
      );
    }

    const ok = await this.login();
    if (!ok) {
      this.log.error(
        'VeSync initial login failed – check credentials / region.',
      );
    }
    return ok;
  }

  private async login(): Promise<boolean> {
    return lock.acquire('auth-call', async () => {
      if (!this.email || !this.password) {
        throw new Error('Email and password are required');
      }

      const now = Date.now();
      const delta = now - this.lastLoginAttempt;
      if (delta < this.loginBackoffMs) {
        const wait = this.loginBackoffMs - delta;
        this.debugMode.debug(
          '[LOGIN]',
          `Backing off for ${wait}ms before next login attempt…`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      this.lastLoginAttempt = Date.now();

      const configuredCC = (
        this.config.options?.countryCode ||
        this.countryCode ||
        'US'
      ).toUpperCase();

      this.countryCode = configuredCC;
      this.baseURL = initialHostForCountry(this.countryCode);

      this.debugMode.debug('[LOGIN]', 'Step 1: authByPWDOrOTM…');
      const { authorizeCode, bizToken: initialBizToken } =
        await this.authByPWDOrOTM(this.countryCode);

      if (
        !authorizeCode ||
        typeof authorizeCode !== 'string' ||
        authorizeCode.trim().length === 0
      ) {
        this.debugMode.debug(
          '[LOGIN]',
          'Step 1 returned an empty authorizeCode; cannot proceed to step 2. Increasing backoff and aborting.',
        );
        this.loginBackoffMs = Math.min(this.loginBackoffMs * 2, 300000);
        return false;
      }

      this.debugMode.debug(
        '[LOGIN]',
        `Step 2: loginByAuthorizeCode on ${this.baseURL}…`,
      );

      let step2Resp = await this.loginByAuthorizeCode4Vesync({
        userCountryCode: this.countryCode,
        authorizeCode,
        bizToken: initialBizToken,
        host: this.baseURL,
      });

      this.debugMode.debug(
        '[LOGIN]',
        'Raw step 2 response:',
        JSON.stringify(step2Resp),
      );

      const codeIsNonZero =
        typeof step2Resp?.code === 'number' ? step2Resp.code !== 0 : true;

      if (
        codeIsNonZero &&
        step2Resp?.result?.bizToken &&
        step2Resp.result.countryCode
      ) {
        const result = step2Resp.result;
        const newCountryCode = (
          result.countryCode ?? this.countryCode
        ).toUpperCase();
        const crossBizToken = result.bizToken || initialBizToken || null;

        this.debugMode.debug(
          '[LOGIN]',
          `Cross-region detected. Switching to countryCode=${newCountryCode} and retrying…`,
        );

        const regionHost = initialHostForCountry(newCountryCode);
        this.baseURL = regionHost;
        this.countryCode = newCountryCode;

        step2Resp = await this.loginByAuthorizeCode4Vesync({
          userCountryCode: this.countryCode,
          authorizeCode,
          bizToken: crossBizToken,
          host: this.baseURL,
          regionChange: 'lastRegion',
        });

        this.debugMode.debug(
          '[LOGIN]',
          'Raw step 2 response after retry:',
          JSON.stringify(step2Resp),
        );
      }

      if (
        !step2Resp?.result?.token ||
        step2Resp.code !== 0 ||
        !step2Resp.result.accountID
      ) {
        this.debugMode.debug(
          '[LOGIN] Failed final step',
          JSON.stringify(step2Resp),
        );
        this.loginBackoffMs = Math.min(this.loginBackoffMs * 2, 300000);
        return false;
      }

      this.loginBackoffMs = 10000;

      const result = step2Resp.result;
      if (!result?.token || !result.accountID) {
        throw new Error('Invalid login response');
      }

      this.accountId = result.accountID;
      this.token = result.token;

      if (result.countryCode) {
        this.countryCode = result.countryCode.toUpperCase();
      }

      if (result.currentRegion) {
        this.region = String(result.currentRegion).toUpperCase();
      }

      this.baseURL = initialHostForCountry(this.countryCode);

      this.buildApiClient();
      await this.saveSessionToDisk();
      return true;
    });
  }

  private async authByPWDOrOTM(
    userCountryCode: string,
  ): Promise<{ authorizeCode: string | null; bizToken: string | null }> {
    const pwdHashed = crypto
      .createHash('md5')
      .update(this.password)
      .digest('hex');

    const body: Record<string, unknown> = {
      email: this.email,
      method: 'authByPWDOrOTM',
      password: pwdHashed,
      acceptLanguage: this.LANG,
      accountID: '',
      authProtocolType: 'generic',
      clientInfo: this.AUTH_CLIENT_INFO,
      clientType: 'vesyncApp',
      clientVersion: this.AUTH_CLIENT_VERSION,
      debugMode: false,
      osInfo: this.AUTH_OS_INFO,
      terminalId: this.terminalId,
      timeZone: this.TIMEZONE,
      token: '',
      userCountryCode,
      appID: this.appID,
      sourceAppID: this.appID,
      traceId: this.generateAuthTraceId(),
    };

    let resp;
    try {
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.AUTH_AXIOS_OPTIONS(this.baseURL),
      );
    } catch (e) {
      this.debugMode.debug(
        '[AUTH] accountAuth on smartapi failed, falling back to accountapi',
        String(e),
      );
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.AUTH_AXIOS_OPTIONS(ACCOUNT_HOST),
      );
    }

    if (!resp?.data?.result || resp.data.code !== 0) {
      this.debugMode.debug(
        '[AUTH] Failed authByPWDOrOTM',
        JSON.stringify(resp?.data),
      );
      throw new Error('VeSync authentication failed at step 1');
    }

    const { authorizeCode = null, bizToken = null } = resp.data.result;
    return { authorizeCode, bizToken };
  }

  private async loginByAuthorizeCode4Vesync(opts: {
    userCountryCode: string;
    host: string;
    authorizeCode: string;
    bizToken?: string | null;
    regionChange?: 'lastRegion';
  }): Promise<LoginResponse | undefined> {
    const {
      userCountryCode,
      host,
      authorizeCode,
      bizToken = null,
      regionChange,
    } = opts;

    const body: Record<string, unknown> = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode,
      acceptLanguage: this.LANG,
      clientInfo: this.AUTH_CLIENT_INFO,
      clientType: 'vesyncApp',
      clientVersion: this.AUTH_CLIENT_VERSION,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: this.AUTH_OS_INFO,
      terminalId: this.terminalId,
      timeZone: this.TIMEZONE,
      userCountryCode,
      traceId: this.generateAuthTraceId(),
    };

    if (bizToken) {
      body.bizToken = bizToken;
    }
    if (regionChange) {
      body.regionChange = regionChange;
    }

    this.debugMode.debug(
      '[LOGIN STEP 2] POST body',
      JSON.stringify({
        ...body,
        bizToken: bizToken ? '***' : undefined,
      }),
    );

    try {
      const resp = await axios.post(
        '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
        body,
        this.AUTH_AXIOS_OPTIONS(host),
      );
      return resp?.data;
    } catch (e) {
      this.debugMode.debug('[LOGIN STEP 2] network error', String(e));
      return undefined;
    }
  }

  public async getDevices(): Promise<VeSyncFan[]> {
    return lock.acquire('api-call', async () => {
      if (!this.api) {
        this.log.error('The user is not logged in!');
        return [];
      }

      await this.ensureValidToken();

      const response = await this.api.post('cloud/v2/deviceManaged/devices', {
        method: 'devices',
        pageNo: 1,
        pageSize: 1000,
        ...this.generateDetailBody(),
        ...this.generateBody(true),
      });

      if (this.handleQuotaExceeded(response.data?.code, response.data?.msg)) {
        return [];
      }

      if (!Array.isArray(response.data?.result?.list)) {
        this.debugMode.debug(
          '[GET DEVICES]',
          'No list found!! JSON:',
          JSON.stringify(response.data),
        );
        return [];
      }

      const { list } = response.data.result ?? { list: [] };

      this.debugMode.debug(
        '[GET DEVICES]',
        'Device List -> JSON:',
        JSON.stringify(list),
      );

      return list
        .filter(
          ({
            deviceType,
            type,
          }: {
            deviceType: string;
            type: string;
          }) =>
            type === 'wifi-air' && VeSyncFan.isDual200SModel(deviceType),
        )
        .map(
          ({
            deviceName,
            mode,
            deviceStatus,
            humidity,
            targetHumidity,
            targetReached,
            configModule,
            cid,
            deviceRegion,
            deviceType,
            macID,
            uuid,
          }: {
            deviceName: string;
            mode: string;
            deviceStatus: boolean;
            humidity: number;
            targetHumidity: number;
            targetReached: boolean;
            configModule: string;
            cid: string;
            deviceRegion: string;
            deviceType: string;
            macID: string;
            uuid: string;
          }) =>
            new VeSyncFan(
              this,
              deviceName,
              mode,
              deviceStatus,
              humidity,
              targetHumidity,
              targetReached,
              configModule,
              cid,
              deviceRegion,
              deviceType,
              macID,
              uuid,
            ),
        );
    });
  }
}