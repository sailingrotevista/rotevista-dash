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
        description: "Configure safety thresholds for depth monitoring.",
        properties: {
          depthDanger: {
            type: 'number',
            title: 'Danger Threshold (Red + Sound)',
            description: "Critical depth level. When depth is below this value, the display turns red and an audible alarm is triggered.",
            default: 2.5
          },
          depthWarning: {
            type: 'number',
            title: 'Warning Threshold (Yellow)',
            description: "Shallow water margin. When depth is below this value, the display turns yellow as a safety warning.",
            default: 5.0
          }
        }
      },
      graphs: {
        type: 'object',
        title: 'Graph & Reef Alerts',
        description: "General settings for graph sampling and tactical wind alerts.",
        properties: {
          reef1: {
            type: 'number',
            title: '1st Reef Threshold (Orange)',
            description: "TWS knots at which the wind graph turns orange, indicating it's time to prepare for the first reef.",
            default: 15.0
          },
          reef2: {
            type: 'number',
            title: '2nd Reef Threshold (Red)',
            description: "TWS knots at which the wind graph turns red, indicating urgent reefing is required.",
            default: 20.0
          },
          historyMinutes: {
            type: 'number',
            title: 'Graph History Duration (minutes)',
            description: "Total timeframe shown in the sparklines. Vertical grid lines will automatically mark each elapsed minute.",
            default: 5
          }
        }
      },
      averaging: {
        type: 'object',
        title: 'Averaging & Stability',
        description: "Fine-tune data smoothing and maneuver detection.",
        properties: {
          longWindow: {
            type: 'number',
            title: 'Long Average Window (ms)',
            description: "Time buffer for 'MEAN' values. Larger windows produce smoother numbers but increase the 'Unstable' (orange) alerts during maneuvers or in gusty conditions, as data coherence decreases over time.",
            default: 30000
          },
          smoothWindow: {
            type: 'number',
            title: 'Pointer Smoothing Window (ms)',
            description: "Buffer for gauge needles and pointers. Removes sensor jitter while maintaining real-time responsiveness.",
            default: 2000
          },
          minSpeed: {
            type: 'number',
            title: 'Min Speed for Stability (knots)',
            description: "SOG threshold below which stability alerts (blinking orange) are suppressed to avoid GPS noise while docked.",
            default: 0.5
          }
        }
      },
      scales: {
        type: 'object',
        title: 'Graph Scale Configurations',
        description: "Customize how scales adapt to your boat's performance in both Standard and Hercules modes.",
        properties: {
          stw: {
            type: 'object', title: 'STW (Speed Through Water)',
            properties: {
              stdMax: {
                type: 'number', title: 'Standard Mode Max',
                description: "The initial top limit of the graph (base 0) during normal navigation.",
                default: 12
              },
              step: {
                type: 'number', title: 'Rounding Step',
                description: "The fixed increment used when speed exceeds the Max (e.g., scale jumps from 0-12 to 0-14, 0-16).",
                default: 2
              },
              hercSpan: {
                type: 'number', title: 'Hercules Zoom Span',
                description: "The minimum knots window centered on current speed. Smaller values increase 'zoom' on small variations.",
                default: 4
              }
            }
          },
          sog: {
            type: 'object', title: 'SOG (Speed Over Ground)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max', description: "Initial top limit for the base-0 scale.", default: 12 },
              step: { type: 'number', title: 'Rounding Step', description: "Scale jump interval to keep labels tidy.", default: 2 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', description: "Minimum window amplitude during active zoom.", default: 4 }
            }
          },
          tws: {
            type: 'object', title: 'TWS (True Wind Speed)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max', description: "Maximum wind speed shown in standard view (base 0).", default: 25 },
              step: { type: 'number', title: 'Rounding Step', description: "Incremental jump for wind scales (usually 5 or 10 knots).", default: 5 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', description: "Minimum knots window for high-detail gust monitoring.", default: 10 }
            }
          },
          depth: {
            type: 'object', title: 'Depth',
            properties: {
              stdMax: { type: 'number', title: 'Standard Mode Max', description: "Default maximum depth for the graph scale.", default: 20 },
              step: { type: 'number', title: 'Rounding Step', description: "Gradual increment steps for deep water navigation.", default: 10 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', description: "Minimum meters window to highlight bottom profile changes.", default: 10 }
            }
          }
        }
      }
    }
  };

  return plugin;
};
