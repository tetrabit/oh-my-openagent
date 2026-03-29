export interface FallbackState {
  triedModels: Map<string, Set<string>>;
  fallbackInProgress: Set<string>;
  lastFallbackTime: Map<string, number>;
}
