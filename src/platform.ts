import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  UnknownContext,
} from 'homebridge';
import * as path from 'node:path';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { getErrorMessage } from './utils/errorMessage';
import VeSyncAccessory from './VeSyncAccessory';
import VeSyncFan from './api/VeSyncFan';
import DebugMode from './debugMode';
import VeSync from './api/VeSync';

export interface VeSyncContext {
  name: string;
  device: VeSyncFan;
}

export type VeSyncPlatformAccessory = PlatformAccessory<VeSyncContext>;

/**
 * Platform class for the Dual200S-only Homebridge plugin.
 */
export default class Platform implements DynamicPlatformPlugin {
  /** Cached accessories loaded from Homebridge storage */
  public readonly cachedAccessories: VeSyncPlatformAccessory[] = [];

  /** Active accessory wrappers */
  public readonly registeredDevices: VeSyncAccessory[] = [];

  public readonly debugger: DebugMode;
  private readonly client: VeSync;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    const { email, password } = this.config ?? {};

    const enableDebugMode =
      (this.config as { enableDebugMode?: boolean }).enableDebugMode ??
      this.config.options?.enableDebugMode ??
      false;

    this.debugger = new DebugMode(!!enableDebugMode, this.log);
    this.debugger.debug('[PLATFORM]', 'Debug mode enabled');

    const storagePath = this.api.user.storagePath();
    const sessionPath = path.join(
      storagePath,
      'homebridge-levoit-dual200s.session.json',
    );

    this.debugger.debug('[PLATFORM]', `Using sessionPath=${sessionPath}`);

    this.client = new VeSync(
      email,
      password,
      this.config,
      this.debugger,
      log,
      sessionPath,
    );

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });
  }

  public get Service(): typeof Service {
    return this.api.hap.Service;
  }

  public get Characteristic(): typeof Characteristic {
    return this.api.hap.Characteristic;
  }

  /**
   * Restore cached accessories from Homebridge storage.
   */
  configureAccessory(accessory: PlatformAccessory<UnknownContext>): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.push(accessory as VeSyncPlatformAccessory);
  }

  /**
   * Discover Dual200S devices from VeSync and register them with Homebridge.
   */
  async discoverDevices(): Promise<void> {
    const { email, password } = this.config ?? {};

    if (!email || !password) {
      if (this.cachedAccessories.length > 0) {
        this.debugger.debug(
          '[PLATFORM]',
          'Removing cached accessories because VeSync credentials are missing.',
          `(Count: ${this.cachedAccessories.length})`,
        );

        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          this.cachedAccessories,
        );
      }

      this.log.error('The VeSync email or password is missing.');
      return;
    }

    try {
      this.log.info('Connecting to the VeSync servers...');
      const ok = await this.client.startSession();

      if (!ok) {
        this.log.error(
          'VeSync login failed – enable debug mode and check logs for [LOGIN]/[SESSION] messages.',
        );
        return;
      }

      this.log.info('Discovering Dual200S devices...');

      const allDevices = await this.client.getDevices();

      const dual200sDevices = allDevices.filter((device: VeSyncFan) =>
        VeSyncFan.isDual200SModel(device.model),
      );

      const devices = dual200sDevices.filter(
        (device: VeSyncFan) => !this.isDeviceExcluded(device),
      );

      if (allDevices.length !== dual200sDevices.length) {
        this.log.info(
          `Ignored ${allDevices.length - dual200sDevices.length} non-Dual200S device(s).`,
        );
      }

      if (dual200sDevices.length !== devices.length) {
        this.log.info(
          `Excluded ${dual200sDevices.length - devices.length} Dual200S device(s) based on config.`,
        );
      }

      await Promise.all(devices.map(this.loadDevice.bind(this)));

      const loadedDeviceUUIDs = new Set<string>(
        devices.map((device: VeSyncFan) => device.uuid),
      );

      this.checkOldDevices(loadedDeviceUUIDs);
    } catch (err: unknown) {
      this.log.error(
        'Unexpected error during device discovery:',
        getErrorMessage(err),
      );
    }
  }

  /**
   * Load or restore a single device accessory.
   */
  private async loadDevice(device: VeSyncFan): Promise<void | null> {
    try {
      await device.updateInfo();

      const { uuid, name } = device;

      const existingAccessory = this.cachedAccessories.find(
        (accessory) => accessory.UUID === uuid,
      );

      if (existingAccessory) {
        this.log.info(
          'Restoring existing accessory from cache:',
          existingAccessory.displayName,
        );

        existingAccessory.context = {
          name,
          device,
        };

        this.registeredDevices.push(
          new VeSyncAccessory(this, existingAccessory),
        );
        return;
      }

      this.log.info('Adding new accessory:', name);

      const accessory = new this.api.platformAccessory<VeSyncContext>(
        name,
        uuid,
      );

      accessory.context = {
        name,
        device,
      };

      this.registeredDevices.push(new VeSyncAccessory(this, accessory));

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
    } catch (error: unknown) {
      this.log.error(
        `Error for device: ${device.name}:${device.uuid} | ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Optional config-based exclusion support.
   * Exclusion is allowed by name or id only.
   */
  private isDeviceExcluded(device: VeSyncFan): boolean {
    const exclude = this.config.exclude;

    if (!exclude) {
      return false;
    }

    const names: string[] = exclude.name ?? [];
    const ids: string[] = exclude.id ?? [];

    if (names.includes(device.name)) {
      return true;
    }

    if (ids.includes(device.uuid) || ids.includes(device.cid)) {
      return true;
    }

    return false;
  }

  /**
   * Remove cached accessories that are no longer present.
   */
  private checkOldDevices(loadedDeviceUUIDs: Set<string>): void {
    this.cachedAccessories.forEach((accessory) => {
      const exists = loadedDeviceUUIDs.has(accessory.UUID);

      if (!exists) {
        this.log.info('Removing accessory:', accessory.displayName);

        const registered = this.registeredDevices.find(
          (d) => d.accessory.UUID === accessory.UUID,
        );

        registered?.stopPolling();

        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);

        const cachedIdx = this.cachedAccessories.indexOf(accessory);
        if (cachedIdx > -1) {
          this.cachedAccessories.splice(cachedIdx, 1);
        }

        if (registered) {
          const regIdx = this.registeredDevices.indexOf(registered);
          if (regIdx > -1) {
            this.registeredDevices.splice(regIdx, 1);
          }
        }
      }
    });
  }
}