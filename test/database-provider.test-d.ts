import type {
	DatabaseProvider,
	NeoOrmClientOptions,
	NeoOrmConfig,
} from "neoorm";

const configProvider: NeoOrmConfig["datasource"]["provider"] = "postgres";
const clientProvider: NonNullable<NeoOrmClientOptions["provider"]> =
	"postgresql";
const shared: DatabaseProvider = configProvider;

void clientProvider;
void shared;
