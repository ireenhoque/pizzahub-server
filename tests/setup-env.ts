// Loads the real .env (MongoDB URI, JWKS config, etc.) before test modules
// are imported. Application modules read env.ts at module load.
import 'dotenv/config';
