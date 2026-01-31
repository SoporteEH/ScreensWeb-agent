/**
 * Identity Service
 * Stores and manages the device's descriptive name and ID.
 */

let deviceName = 'PC CUOTAS';
let deviceId = null;

function setDeviceName(name) {
    if (name) {
        deviceName = name;
    }
}

function getDeviceName() {
    return deviceName;
}

function setDeviceId(id) {
    deviceId = id;
}

function getDeviceId() {
    return deviceId;
}

module.exports = {
    setDeviceName,
    getDeviceName,
    setDeviceId,
    getDeviceId
};
