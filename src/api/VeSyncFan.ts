import AsyncLock from 'async-lock';
import { getErrorMessage } from '../utils/errorMessage';
import VeSync, { BypassMethod, DEVICE_UNREACHABLE_ERROR } from './VeSync';

export enum Mode {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * VeSyncFan represents a single Dual200S humidifier.
 * This plugin supports only this one device model.
 */
export default class VeSyncFan {
  private readonly lock = new AsyncLock();

  /**
   * Fixed humidity limits for the Dual200S.
   */
  public readonly minHumidityLevel = 30;
  public readonly maxHumidityLevel = 80;

  private lastCheck = 0;

  private _humidityLevel = 0;
  private _targetHumidity = 0;
  private _mode: Mode = Mode.Auto;
  private _isOn = false;
  private _targetReached = false;

  public readonly manufacturer = 'Levoit';

  constructor(
    private readonly client: VeSync,
    public readonly name: string,
    mode: string,
    deviceStatus: boolean,
    humidity: number,
    targetHumidity: number,
    targetReached: boolean,
    public readonly configModule: string,
    public readonly cid: string,
    public readonly region: string,
    public readonly model: string,
    public readonly mac: string,
    public readonly uuid: string,
  ) {
    this._mode = this.normalizeMode(mode);
    this._isOn = !!deviceStatus;
    this._humidityLevel = Number.isFinite(humidity) ? humidity : 0;
    this._targetHumidity = Number.isFinite(targetHumidity) ? targetHumidity : 0;
    this._targetReached = !!targetReached;
  }

  public get humidityLevel(): number {
    return this._humidityLevel;
  }

  public get targetHumidity(): number {
    return this._targetHumidity;
  }

  public get mode(): Mode {
    return this._mode;
  }

  public get targetReached(): boolean {
    return this._targetReached;
  }

  public get isOn(): boolean {
    return this._isOn;
  }

  private resetStateToOff(): void {
    this._isOn = false;
    this._targetReached = false;
  }

  private normalizeMode(mode: string | undefined | null): Mode {
    if (mode === Mode.Manual) {
      return Mode.Manual;
    }

    return Mode.Auto;
  }

  public async setPower(power: boolean): Promise<boolean> {
    this.client.log.info('Setting Power to ' + power);

    const success = await this.client.sendCommand(
      this,
      BypassMethod.SWITCH,
      {
        enabled: power,
        id: 0,
      },
    );

    if (success) {
      this._isOn = power;
      if (!power) {
        this._targetReached = false;
      }
    } else {
      this.client.log.error('Failed to setPower due to unreachable device.');
      if (this.client.config.options?.showOffWhenDisconnected) {
        this.resetStateToOff();
      } else {
        return false;
      }
    }

    return success;
  }

  public async setTargetHumidity(level: number): Promise<boolean> {
    this.client.log.info('Setting Target Humidity to ' + level);

    const success = await this.client.sendCommand(
      this,
      BypassMethod.HUMIDITY,
      {
        target_humidity: level,
        id: 0,
      },
    );

    if (success) {
      this._targetHumidity = level;
    }

    return success;
  }

  public async changeMode(mode: Mode): Promise<boolean> {
    const normalizedMode = this.normalizeMode(mode);

    if (this._mode === normalizedMode) {
      return true;
    }

    this.client.log.info('Changing Mode to ' + normalizedMode);

    const success = await this.client.sendCommand(
      this,
      BypassMethod.MODE,
      {
        mode: normalizedMode,
        id: 0,
      },
    );

    if (success) {
      this._mode = normalizedMode;
    }

    return success;
  }

  public async updateInfo(): Promise<void> {
    return this.lock.acquire('update-info', async () => {
      try {
        if (Date.now() - this.lastCheck < 15 * 1000) {
          return;
        }

        const data = await this.client.getDeviceInfo(this);
        this.lastCheck = Date.now();

        const result = data?.result?.result;

        if (!result && this.client.config.options?.showOffWhenDisconnected) {
          this.resetStateToOff();
          return;
        }

        if (!result) {
          return;
        }

        this._humidityLevel = (result.humidity as number) ?? 0;
        this._targetHumidity =
          (result.configuration?.auto_target_humidity as number) ?? 0;
        this._mode = this.normalizeMode(result.mode as string);
        this._isOn = (result.enabled as boolean) ?? false;
        this._targetReached =
          (result.automatic_stop_reach_target as boolean) ?? false;
      } catch (err: unknown) {
        this.client.log.error(
          'Failed to updateInfo due to unreachable device: ' +
            getErrorMessage(err),
        );

        if (this.client.config.options?.showOffWhenDisconnected) {
          this.resetStateToOff();
        } else {
          throw new Error(DEVICE_UNREACHABLE_ERROR);
        }
      }
    });
  }

  public static isDual200SModel(model: string): boolean {
    return (
      typeof model === 'string' &&
      (model.includes('Dual200S') || model.includes('LUH-D301S-'))
    );
  }
}