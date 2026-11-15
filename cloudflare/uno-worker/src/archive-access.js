const encoder = new TextEncoder();

export function constantTimeStringEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const maxLength = Math.max(leftBytes.length, rightBytes.length);
    let difference = leftBytes.length ^ rightBytes.length;

    for (let index = 0; index < maxLength; index += 1) {
        difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }

    return difference === 0;
}

export function isValidArchiveAccessTicket(ticket, uid) {
    return Boolean(
        ticket &&
        ticket.kind === "caca-archive-access" &&
        typeof uid === "string" &&
        uid.length > 0 &&
        ticket.uid === uid
    );
}
