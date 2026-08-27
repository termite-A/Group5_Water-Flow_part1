import cors from 'cors';
import express, { Request, Response } from 'express';
import mysql, { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

type SystemState = 'NORMAL' | 'WARNING' | 'CRITICAL';
type ControlMode = 'AUTO' | 'MANUAL';
interface Telemetry extends RowDataPacket { id: number; water_level: number; valve_angle: number; water_analog: number; system_state: SystemState; control_mode: ControlMode; estop_latched: boolean; created_at: Date; }
interface SystemConfig extends RowDataPacket { id: number; warn_threshold: number; crit_threshold: number; wet_threshold: number; updated_at: Date; }

const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));
const pool = mysql.createPool({ host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '', database: process.env.DB_NAME ?? 'smart_irrigation', waitForConnections: true, connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10) });
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const inRange = (value: unknown, min: number, max: number): value is number => isInteger(value) && value >= min && value <= max;
const isMode = (value: unknown): value is ControlMode => value === 'AUTO' || value === 'MANUAL';
let requestedMode: ControlMode = 'AUTO';
let requestedAngle = 0;
let requestedEstop = false;
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { handler(req, res).catch((error: unknown) => res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error' })); };
async function getConfig(): Promise<SystemConfig | null> { const [rows] = await pool.query<SystemConfig[]>('SELECT * FROM system_config WHERE id = 1'); return rows[0] ?? null; }

app.get('/api/telemetry/latest', asyncRoute(async (_req, res) => { const [rows] = await pool.query<Telemetry[]>('SELECT * FROM telemetry_logs ORDER BY id DESC LIMIT 1'); res.json({ latest: rows[0] ?? null, config: await getConfig() }); }));
app.get('/api/telemetry/history', asyncRoute(async (_req, res) => { const [rows] = await pool.query<Telemetry[]>('SELECT * FROM telemetry_logs ORDER BY id DESC LIMIT 30'); res.json(rows.reverse()); }));
app.get('/api/control/state', (_req, res) => res.json({ mode: requestedMode, angle: requestedAngle, estop_latched: requestedEstop }));
app.post('/api/telemetry', asyncRoute(async (req, res) => {
  const { water_level, valve_angle, water_analog, system_state, control_mode, estop_latched } = req.body as Record<string, unknown>;
  if (!inRange(water_level, 0, 100) || !inRange(valve_angle, 0, 90) || !inRange(water_analog, 0, 4095) || !['NORMAL', 'WARNING', 'CRITICAL'].includes(String(system_state)) || !isMode(control_mode) || typeof estop_latched !== 'boolean') { res.status(400).json({ error: 'Invalid telemetry payload' }); return; }
  const [result] = await pool.execute<ResultSetHeader>('INSERT INTO telemetry_logs (water_level, valve_angle, water_analog, system_state, control_mode, estop_latched) VALUES (?, ?, ?, ?, ?, ?)', [water_level, valve_angle, water_analog, system_state, control_mode, estop_latched]);
  res.status(201).json({ status: 'success', id: result.insertId });
}));
app.post('/api/control/mode', asyncRoute(async (req, res) => { const { mode } = req.body as { mode?: unknown }; if (!isMode(mode)) { res.status(400).json({ error: 'mode must be AUTO or MANUAL' }); return; } requestedMode = mode; res.json({ mode }); }));
app.post('/api/control/valve', asyncRoute(async (req, res) => { const { angle } = req.body as { angle?: unknown }; if (!inRange(angle, 0, 90)) { res.status(400).json({ error: 'angle must be an integer from 0 to 90' }); return; } requestedAngle = angle; requestedMode = 'MANUAL'; res.json({ angle, mode: requestedMode }); }));
app.post('/api/control/estop', asyncRoute(async (req, res) => { const { latched } = req.body as { latched?: unknown }; if (typeof latched !== 'boolean') { res.status(400).json({ error: 'latched must be boolean' }); return; } requestedEstop = latched; res.json({ latched }); }));
app.put('/api/config', asyncRoute(async (req, res) => { const { warn_threshold, crit_threshold, wet_threshold } = req.body as Record<string, unknown>; if (!inRange(warn_threshold, 0, 100) || !inRange(crit_threshold, 0, 100) || !inRange(wet_threshold, 0, 4095) || warn_threshold >= crit_threshold) { res.status(400).json({ error: 'Thresholds are out of range or ordered incorrectly' }); return; } await pool.execute('UPDATE system_config SET warn_threshold = ?, crit_threshold = ?, wet_threshold = ? WHERE id = 1', [warn_threshold, crit_threshold, wet_threshold]); res.json({ config: await getConfig() }); }));

const port = Number(process.env.PORT ?? 5000);
app.listen(port, () => console.log(`Smart irrigation API listening on port ${port}`));
export default app;
