// Stand-in for a real `db:reset`. The example keeps state in memory, so there
// is nothing to drop — this exists so repro has a setup command to detect.
console.log('database reset')
