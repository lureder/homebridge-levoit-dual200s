# Homebridge Levoit Dual200S

A minimal Homebridge plugin for the **Levoit Dual200S Smart Humidifier**.

This plugin is intentionally focused on a single device model and exposes only the core humidifier functionality in HomeKit.

---

## Features

- Supports **Levoit Dual200S only**
- Exposes a single **Humidifier** service
- Control power (On / Off)
- Set target humidity
- View current humidity

---

## Installation

1. Install this plugin using: npm install -g homebridge-levoit-dual200s
2. Use plugin settings to edit config.json and add your account details.

---

## Configuration

Example configuration:

```json
{
  "platform": "LevoitDual200S",
  "name": "Levoit Dual200S",
  "email": "your@email.com",
  "password": "yourpassword",
  "options": {
    "countryCode": "CA",
    "enableDebugMode": false
  }
}
```

### Options

| Option | Description |
|--------|------------|
| email | Your VeSync account email |
| password | Your VeSync account password |
| countryCode | Your VeSync account country (US, CA, GB, FR, etc.) |
| enableDebugMode | Enables detailed logging |
| showOffWhenDisconnected | Shows the device as off if unreachable |

## Attribution

This project is a derivative of
homebridge-levoit-humidifiers by @pschroeder89,
licensed under the Apache License 2.0.
