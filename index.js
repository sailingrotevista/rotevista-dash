module.exports = function (app) {
  const plugin = {};
  plugin.id = 'rotevista-dash';
  plugin.name = 'Rotevista Dash Configuration';
  plugin.description = 'Configura i parametri della barca per la Dashboard';

  plugin.start = function (options, restartServer) {
    app.debug('Rotevista Dash Plugin Started');
  };

  plugin.stop = function () {
    app.debug('Rotevista Dash Plugin Stopped');
  };

  // Qui definiamo la maschera che vedrai su SignalK
  plugin.schema = {
    type: 'object',
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
        title: 'Soglie Terzaroli (Nodi TWS)',
        properties: {
          reef1: { type: 'number', title: '1° Mano (Arancio)', default: 15.0 },
          reef2: { type: 'number', title: '2° Mano (Rosso)', default: 20.0 }
        }
      },
      averages: {
        type: 'object',
        title: 'Medie e Stabilità',
        properties: {
          longWindow: { type: 'number', title: 'Finestra Medie MEAN (millisecondi)', default: 60000 },
          minSpeed: { type: 'number', title: 'Velocità minima stabilità (nodi)', default: 0.5 }
        }
      }
    }
  };

  return plugin;
};