const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'result_DFA9FEBB-9289-449C-8FF0-A8A2F104AC7E.json');
try {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log('JSON valid. verdict:', data.verdict);
  if (!data.verdict || !data.fullAnalysis) {
    console.error('MISSING required fields!');
    process.exit(1);
  }
} catch(e) {
  console.error('JSON INVALID:', e.message);
  process.exit(1);
}
