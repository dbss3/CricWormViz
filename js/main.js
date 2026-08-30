import { processMatch } from './dataProcessor.js';
import { renderChart }  from './wormChart.js';

fetch('./data/match.json')
  .then(r => r.json())
  .then(raw => {
    const matchData = processMatch(raw);
    renderChart(document.getElementById('chart-root'), matchData);
  })
  .catch(err => {
    document.getElementById('chart-root').textContent = 'Error loading data: ' + err.message;
    console.error(err);
  });
