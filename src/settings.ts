export const PLATFORM_NAME = 'LevoitDual200S';
export const PLUGIN_NAME = 'homebridge-levoit-dual200s';

export interface PlatformConfigShape {
  name?: string;
  email?: string;
  password?: string;
  options?: {
    enableDebugMode?: boolean;
    showOffWhenDisconnected?: boolean;
    countryCode?: string;
    apiTimeout?: number;
  };
  exclude?: {
    name?: string[];
    id?: string[];
  };
}