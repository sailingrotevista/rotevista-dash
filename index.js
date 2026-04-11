module.exports = function (app) {
  const plugin = {};
  plugin.id = 'rotevista-dash';
  plugin.name = 'Rotevista Dash Configuration';
  plugin.description = 'Configure boat-specific parameters for the Dashboard';

  plugin.start = function (options) { };
  plugin.stop = function () { };

  plugin.schema = {
    type: 'object',
    title: 'Rotevista Dashboard Settings',
    properties: {
      alarms: {
        type: 'object',
        title: 'Depth Alarms (meters)',
        description: "qui un commento",
        properties: {
          depthDanger: { type: 'number', title: 'Danger Threshold (Red + Sound)', description: "qui un commento", default: 2.5 },
          depthWarning: { type: 'number', title: 'Warning Threshold (Yellow)', description: "qui un commento", default: 5.0 }
        }
      },
      graphs: {
        type: 'object',
        title: 'Graph & Reef Alerts',
        description: "qui un commento",
        properties: {
          reef1: { type: 'number', title: '1st Reef Threshold (Orange)', description: "qui un commento", default: 15.0 },
          reef2: { type: 'number', title: '2nd Reef Threshold (Red)', description: "qui un commento", default: 20.0 },
          historyMinutes: { type: 'number', title: 'Graph History Duration (minutes)', description: "qui un commento", default: 5 }
        }
      },
      averaging: {
        type: 'object',
        title: 'Averaging & Stability',
        description: "qui un commento",
        properties: {
          longWindow: { type: 'number', title: 'Long Average Window (ms)', description: "qui un commento", default: 60000 },
          smoothWindow: { type: 'number', title: 'Pointer Smoothing Window (ms)', description: "qui un commento", default: 2000 },
          minSpeed: { type: 'number', title: 'Min Speed for Stability (knots)', description: "qui un commento", default: 0.5 }
        }
      },
      scales: {
        type: 'object',
        title: 'Graph Scale Configurations (Standard Max, Hercules Span, Step)',
        description: "qui un commento",
        properties: {
          stw: {
            type: 'object', title: 'STW (Speed Through Water)',
            description: "qui un commento",
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', description: "qui un commento", default: 12 },
              hercSpan: { type: 'number', title: 'Hercules Span', description: "qui un commento", default: 4 },
              step: { type: 'number', title: 'Rounding Step', description: "qui un commento", default: 2 }
            }
          },
          sog: {
            type: 'object', title: 'SOG (Speed Over Ground)',
            description: "qui un commento",
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', description: "qui un commento", default: 12 },
              hercSpan: { type: 'number', title: 'Hercules Span', description: "qui un commento", default: 4 },
              step: { type: 'number', title: 'Rounding Step', description: "qui un commento", default: 2 }
            }
          },
          tws: {
            type: 'object', title: 'TWS (True Wind Speed)',
            description: "qui un commento",
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', description: "qui un commento", default: 25 },
              hercSpan: { type: 'number', title: 'Hercules Span', description: "qui un commento", default: 10 },
              step: { type: 'number', title: 'Rounding Step', description: "qui un commento", default: 5 }
            }
          },
          depth: {
            type: 'object', title: 'Depth',
            description: "qui un commento",
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', description: "qui un commento", default: 20 },
              hercSpan: { type: 'number', title: 'Hercules Span', description: "qui un commento", default: 10 },
              step: { type: 'number', title: 'Rounding Step', description: "qui un commento", default: 10 }
            }
          }
        }
      }
    }
  };

  return plugin;
};
