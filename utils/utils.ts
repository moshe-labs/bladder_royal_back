// Generate a random hex color for user avatars
export function randomColor(): string {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9']
    return colors[Math.floor(Math.random() * colors.length)]
}

export function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : undefined
}
