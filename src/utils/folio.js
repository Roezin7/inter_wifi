function generateFolio(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${y}${m}${day}-${rnd}`;
}

async function withGeneratedFolio({ prefix, maxAttempts = 3, insert }) {
  if (typeof insert !== "function") {
    throw new TypeError("withGeneratedFolio requires an insert function");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const folio = generateFolio(prefix);

    try {
      return await insert(folio);
    } catch (error) {
      if (String(error?.code) === "23505" && attempt < maxAttempts - 1) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Could not generate unique folio for prefix ${prefix}`);
}

module.exports = { generateFolio, withGeneratedFolio };
