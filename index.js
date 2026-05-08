/**
 * ==========================================================================
 * Rotevista Dash Configuration Plugin
 * ==========================================================================
 * Definisce l'interfaccia di configurazione in Signal K Admin e crea
 * l'endpoint pubblico per la comunicazione con la Dashboard.
 */

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'rotevista-dash';
  plugin.name = 'Rotevista Dash Configuration';
  plugin.description = 'Configure boat-specific tactical and safety parameters for the Dashboard';

  let currentConfig = {};
  let routeRegistered = false;

  /**
   * plugin.start: Inizializza il plugin.
   * Viene chiamato all'avvio e OGNI VOLTA che clicchi "Save" nelle impostazioni.
   */
  plugin.start = function (options) {
    // 1. Aggiorna la configurazione in memoria (per l'endpoint pubblico)
    currentConfig = options;

    // 2. Log di debug nel server Signal K
    app.debug(`${plugin.name} started/updated with new options`);

    // 3. Registra la rotta API solo la prima volta
    if (!routeRegistered) {
      app.get('/rotevista-config', (req, res) => {
        res.json(currentConfig);
      });
      routeRegistered = true;
      app.debug('Public API endpoint registered at /rotevista-config');
    }
  };

  /**
   * plugin.stop: Chiamato quando il plugin viene disattivato o prima di un aggiornamento.
   */
  plugin.stop = function () {
    app.debug(`${plugin.name} stopped`);
  };

  // Se desideri avere una funzione plugin.debug personalizzata (opzionale)
  plugin.debug = function(msg) {
    app.debug(msg);
  };

  /**
   * plugin.schema: Definisce l'interfaccia grafica in Signal K Admin.
   */
  plugin.schema = {
    type: 'object',
    title: 'Rotevista Dashboard Settings',
    properties: {
      // --- SEZIONE ALLARMI PROFONDITÀ ---
      alarms: {
        type: 'object',
        title: 'Depth Safety Alarms',
        description: "Configure safety thresholds for depth monitoring based on your boat's draft.",
        properties: {
          depthDanger: {
            type: 'number',
            title: 'Emergency Depth (Red + Sound)',
            description: "Critical depth level. Below this limit, the display turns RED and the audible 'Bing-Bing' alarm starts.",
            default: 2.5
          },
          depthWarning: {
            type: 'number',
            title: 'Safety Margin (Yellow)',
            description: "Shallow water warning. The depth value turns YELLOW below this threshold to alert you to pay attention.",
            default: 5.0
          }
        }
      },
      // --- SEZIONE GRAFICI E REEF ---
      graphs: {
        type: 'object',
        title: 'Performance History & Reef Alerts',
        description: "Settings for chart timelines and tactical wind alerts.",
        properties: {
          reef1: {
            type: 'number',
            title: '1st Reef Alert (Orange)',
            description: "Wind speed (TWS) at which the graph turns orange, suggesting it's time to prepare for the first sail reduction.",
            default: 15.0
          },
          reef2: {
            type: 'number',
            title: '2nd Reef Alert (Red)',
            description: "Wind speed (TWS) at which the graph turns red, indicating urgent need for sail reduction.",
            default: 20.0
          },
          historyMinutes: {
            type: 'number',
            title: 'Strategic Timeline (Minutes)',
            description: "Total duration shown in the charts. Vertical grid lines mark 1-minute intervals for short durations and 5-minute intervals for long ones.",
            default: 5,
            enum: [5, 10, 15, 30, 60]
          }
        }
      },
      // --- SEZIONE MEDIE E STABILITÀ ---
      averaging: {
        type: 'object',
        title: 'Tactical Brain & Stability',
        description: "Fine-tune how the dashboard reacts to boat movements and maneuvers.",
        properties: {
          longWindow: {
            type: 'number',
            title: 'Decision Stability Window (ms)',
            description: "The time range used to calculate MEAN values. A longer window (e.g. 30s) provides a solid base for strategy, while a shorter one reacts faster to every oscillation.",
            default: 30000
          },
          smoothWindow: {
            type: 'number',
            title: 'Needle Fluidity (ms)',
            description: "Controls how smoothly pointers move. It filters out sensor 'shaking' without delaying the real-time feel.",
            default: 2000
          },
          minSpeed: {
            type: 'number',
            title: 'Harbor Silence (knots)',
            description: "Minimum speed required to enable orange blinking alerts. This prevents the display from flashing due to GPS noise while docked or at anchor.",
            default: 0.5
          },
          stabilityThreshold: {
            type: 'number',
            title: 'Steering Precision (Sensitivity)',
            description: "Controls how strictly the system judges your course coherence. 0.95 requires pro precision; 0.85 is more realistic for cruising in waves.",
            default: 0.85
          },
          stabilityBreakout: {
            type: 'number',
            title: 'Maneuver Detection Limit (degrees)',
            description: "If the boat or wind shifts more than these degrees, the display blinks orange to warn you that the current average is no longer reliable.",
            default: 15
          }
        }
      },
      // --- SEZIONE CALIBRAZIONE SCALE ---
      scales: {
        type: 'object',
        title: 'Chart Scale Calibration',
        description: "Customize how charts adapt to your boat's performance in both Standard and Hercules Zoom modes.",
        properties: {
          stw: {
            type: 'object',
            title: 'STW (Speed Through Water)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', description: "Default top limit of the graph.", default: 12 },
              step: { type: 'number', title: 'Scale Jump', description: "Amount the scale increases when you exceed the limit.", default: 2 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', description: "Width of the zoom window around your current speed.", default: 4 }
            }
          },
          sog: {
            type: 'object',
            title: 'SOG (Speed Over Ground)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', default: 12 },
              step: { type: 'number', title: 'Scale Jump', default: 2 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', default: 4 }
            }
          },
          tws: {
            type: 'object',
            title: 'TWS (True Wind Speed)',
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', default: 25 },
              step: { type: 'number', title: 'Scale Jump', default: 5 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', default: 10 }
            }
          },
          depth: {
            type: 'object',
            title: 'Depth',
            properties: {
              stdMax: { type: 'number', title: 'Standard Max', default: 20 },
              step: { type: 'number', title: 'Scale Jump', default: 10 },
              hercSpan: { type: 'number', title: 'Hercules Zoom Span', default: 10 }
            }
          }
        }
      }
    }
  };

  return plugin;
};
