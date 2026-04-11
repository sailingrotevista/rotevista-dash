module.exports = function (app) {
  const plugin = {};

  plugin.id = 'rotevista-dash'; // ID univoco per il plugin
  plugin.name = 'Rotevista Dash Config';
  plugin.description = 'Impostazioni centralizzate per la Dashboard Rotevista';

  plugin.start = function (options, restartServer) {
    app.debug('Plugin Rotevista Dash avviato con opzioni:', options);
  };

  plugin.stop = function () {
    app.debug('Plugin Rotevista Dash fermato');
  };

  // Schema conforme alla doc di SignalK per generare la UI
  plugin.schema = {
    type: 'object',
    title: 'Configurazione Barca',
    properties: {
      alarms: {
        type: 'object',
        title: 'Allarmi Profondità (metri)',
        properties: {
          depthDanger: { type: 'number', title: 'Pericolo (Rosso)', default: 2.5 },
          depthWarning: { type: 'number', title: 'Pre-allarme (Giallo)', default: 5.0 }
        }
      },
      graphs: {
        type: 'object',
        title: 'Soglie Vento (Nodi TWS)',
        properties: {
          reef1: { type: 'number', title: 'Soglia Arancio (1° Mano)', default: 15.0 },
          reef2: { type: 'number', title: 'Soglia Rossa (2° Mano)', default: 20.0 }
        }
      },
      averages: {
        type: 'object',
        title: 'Parametri Medie',
        properties: {
          longWindow: { type: 'number', title: 'Finestra Medie LUNGHE (ms)', default: 60000 },
          minSpeed: { type: 'number', title: 'Velocità Minima Stabilità (kts)', default: 0.5 }
        }
      }
    }
  };

  return plugin;
};
