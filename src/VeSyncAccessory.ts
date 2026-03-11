import {
  CharacteristicValue,
  Nullable,
  Service,
} from 'homebridge';

import { getErrorMessage } from './utils/errorMessage';
import { debounceSet } from './utils/debounce';
import { Mode } from './api/VeSyncFan';
import Platform, { VeSyncPlatformAccessory } from './platform';

const HumidifierName = 'Humidifier';

/**
 * VeSyncAccessory represents a single Levoit humidifier device in HomeKit.
 * This Dual200S-only version exposes a single Humidifier service with:
 * - Active
 * - CurrentHumidifierDehumidifierState
 * - TargetHumidifierDehumidifierState
 * - RelativeHumidityHumidifierThreshold
 * - CurrentRelativeHumidity
 */
export default class VeSyncAccessory {
  private readonly humidifierService: Service;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL_MS = 30000;

  private get device() {
    return this.accessory.context.device;
  }

  constructor(
    private readonly platform: Platform,
    public readonly accessory: VeSyncPlatformAccessory,
  ) {
    this.setupAccessoryInfo();
    this.humidifierService = this.setupHumidifierService();
    this.startPolling();
  }

  private setupAccessoryInfo(): void {
    const { manufacturer, model, mac } = this.device;

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        manufacturer,
      )
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, mac);
  }

  private setupHumidifierService(): Service {
    const apiName = this.device?.name;
    const serviceName =
      typeof apiName === 'string' && apiName.trim() !== ''
        ? apiName.trim()
        : HumidifierName;

    let service = this.accessory.getService(serviceName);

    if (!service) {
      service = new this.platform.Service.HumidifierDehumidifier(
        serviceName,
        serviceName,
      );
      this.accessory.addService(service);
    }

    this.ensureConfiguredName(service, serviceName);
    service.setPrimaryService(true);

    service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(async (): Promise<Nullable<CharacteristicValue>> => {
        return this.device.isOn ? 1 : 0;
      })
      .onSet(async (value: CharacteristicValue) => {
        const nextIsOn = Number(value) === 1;

        if (nextIsOn === this.device.isOn) {
          return;
        }

        const success = await this.device.setPower(nextIsOn);
        if (success) {
          this.updateAllCharacteristics();
        }
      });

    service
      .getCharacteristic(
        this.platform.Characteristic.TargetHumidifierDehumidifierState,
      )
      .setProps({ validValues: [1] })
      .onGet(async (): Promise<Nullable<CharacteristicValue>> => {
        return (
          this.platform.Characteristic.TargetHumidifierDehumidifierState
            .HUMIDIFIER
        );
      });

    service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      )
      .setProps({ validValues: [1, 2] })
      .onGet(async (): Promise<Nullable<CharacteristicValue>> => {
        return this.getCurrentHumidifierState();
      });

    service
  .getCharacteristic(
    this.platform.Characteristic.RelativeHumidityHumidifierThreshold,
  )
  .setProps({
    minStep: 1,
    minValue: 0,
    maxValue: 100,
  })
  .onGet(async (): Promise<Nullable<CharacteristicValue>> => {
    return this.device.targetHumidity;
  })
  .onSet(async (value: CharacteristicValue) => {
    debounceSet(
      this.device.uuid,
      value,
      async (finalValue) => {
        try {
          if (!this.device.isOn) {
            await this.device.setPower(true);
          }

          let humidity = finalValue;
          if (humidity < this.device.minHumidityLevel) {
            humidity = this.device.minHumidityLevel;
          }
          if (humidity > this.device.maxHumidityLevel) {
            humidity = this.device.maxHumidityLevel;
          }

          if (this.device.mode === Mode.Manual) {
            await this.device.changeMode(Mode.Auto);
          }

          await this.device.setTargetHumidity(humidity);
          this.updateAllCharacteristics();
        } catch (err) {
          this.platform.log.debug(
            `[HUMIDITY] debounced set failed: ${getErrorMessage(err)}`,
          );
        }
      },
      (message) => this.platform.log.debug(message),
    );
  });

    service
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(async (): Promise<Nullable<CharacteristicValue>> => {
        return Number.isFinite(this.device.humidityLevel)
          ? this.device.humidityLevel
          : 0;
      });

    return service;
  }

  /**
   * Sets ConfiguredName on a service, preserving user renames via HAPStorage.
   */
  private ensureConfiguredName(service: Service, name: string): void {
    const key = `homebridge-levoit-dual200s-configured-name-${this.device.uuid}`;

    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);

    const storedValue = this.platform.api.hap.HAPStorage.storage().getItemSync(key);
    const configuredName =
      typeof storedValue === 'string' && storedValue.trim() !== ''
        ? storedValue
        : name;

    service.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      configuredName,
    );

    service
      .getCharacteristic(this.platform.Characteristic.ConfiguredName)
      .on('change', ({ newValue }) => {
        this.platform.api.hap.HAPStorage.storage().setItemSync(key, newValue);
      });
  }

  private getCurrentHumidifierState(): number {
    const { HUMIDIFYING, IDLE } =
      this.platform.Characteristic.CurrentHumidifierDehumidifierState;

    if (!this.device.isOn) {
      return IDLE;
    }

    if (this.device.mode === Mode.Manual) {
      return HUMIDIFYING;
    }

    if (
      this.device.targetReached ||
      this.device.humidityLevel >= this.device.targetHumidity
    ) {
      return IDLE;
    }

    return HUMIDIFYING;
  }

  private startPolling(): void {
    this.device.updateInfo().catch((err) => {
      this.platform.log.debug(
        `[${this.device.name}] Initial device update failed: ${getErrorMessage(err)}`,
      );
    });

    this.pollingInterval = setInterval(() => {
      this.device.updateInfo()
        .then(() => {
          this.updateAllCharacteristics();
        })
        .catch((err) => {
          this.platform.log.debug(
            `[${this.device.name}] Background polling update failed: ${getErrorMessage(err)}`,
          );
        });
    }, this.POLLING_INTERVAL_MS);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  public updateAllCharacteristics(): void {
    const { Characteristic } = this.platform;

    this.humidifierService
      .getCharacteristic(Characteristic.Active)
      .updateValue(this.device.isOn ? 1 : 0);

    this.humidifierService
      .getCharacteristic(
        Characteristic.CurrentHumidifierDehumidifierState,
      )
      .updateValue(this.getCurrentHumidifierState());

    this.humidifierService
      .getCharacteristic(
        Characteristic.TargetHumidifierDehumidifierState,
      )
      .updateValue(
        Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
      );

    this.humidifierService
      .getCharacteristic(
        Characteristic.RelativeHumidityHumidifierThreshold,
      )
      .updateValue(this.device.targetHumidity);

    this.humidifierService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .updateValue(this.device.humidityLevel);
  }
}
