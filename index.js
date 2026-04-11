module.exports = function (app) {
  const plugin = {};
  plugin.id = 'rotevista-dash';
  plugin.name = 'Rotevista Dash Configuration';

  plugin.start = function (options) { };
  plugin.stop = function () { };

  plugin.schema = {
    type: 'object',
    title: 'Rotevista Dashboard Settings',
    properties: {
      alarms: {
        type: 'object',
        title: 'Depth Alarms (meters)',
        properties: {
          depthDanger: { type: 'number', title: 'Danger Threshold (Red + Sound)', default: 2.5 },
          depthWarning: { type: 'number', title: 'Warning Threshold (Yellow)', default: 5.0 }
        }
      },
      graphs: {
        type: 'object',
        title: 'Wind Reef Alerts (TWS Knots)',
        properties: {
          reef1: { type: 'number', title: '1st Reef Threshold (Orange Line)', default: 15.0 },
          reef2: { type: 'number', title: '2nd Reef Threshold (Red Line)', default: 20.0 }
        }
      },
      averaging: {
        type: 'object',
        title: 'Averaging & Stability',
        properties: {
          longWindow: { type: 'number', title: 'Long Average Window (ms)', default: 60000 },
          smoothWindow: { type: 'number', title: 'Pointer Smoothing Window (ms)', default: 2000 },
          minSpeed: { type: 'number', title: 'Min Speed for Stability (knots)', default: 0.5 }
        }
      },
      scales: {
        type: 'object',
        title: 'Graph Scale Configurations',
        properties: {
          stw: {
            type: 'object', title: 'STW (Speed Through Water)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max Value', default: 12 },
              hercSpan: { type: 'number', title: 'Hercules Mode Zoom Span', default: 4 },
              step: { type: 'number', title: 'Rounding Step', default: 2 }
            }
          },
          sog: {
            type: 'object', title: 'SOG (Speed Over Ground)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max Value', default: 12 },
              hercSpan: { type: 'number', title: 'Hercules Mode Zoom Span', default: 4 },
              step: { type: 'number', title: 'Rounding Step', default: 2 }
            }
          },
          tws: {
            type: 'object', title: 'TWS (True Wind Speed)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max Value', default: 25 },
              hercSpan: { type: 'number', title: 'Hercules Mode Zoom Span', default: 10 },
              step: { type: 'number', title: 'Rounding Step', default: 5 }
            }
          },
          depth: {
            type: 'object', title: 'Depth',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max Value', default: 20 },
              hercSpan: { type: 'number', title: 'Hercules Mode Zoom Span', default: 10 },
              step: { type: 'number', title: 'Rounding Step', default: 10 }
            }
          }
        }
      }
    }
  };

  return plugin;
};
