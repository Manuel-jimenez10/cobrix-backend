/**
 * Redactor: arma el recordatorio de cobranza a partir de las plantillas aprobadas
 * por Meta (amable → firme → final). Sin IA: el mensaje es predecible, sale al
 * instante y se puede enviar en cualquier momento, incluso fuera de la ventana de 24 h.
 */
import type { Db } from '../domain/db.js';
import { facturasAbiertas } from '../domain/logic.js';
import { formatMXN, primerNombre } from '../shared/format.js';
import { plantillas } from '../shared/plantillas.js';
import { llenarPlantilla } from '../shared/reglas.js';
import type { ClienteResumen, Tono } from '../shared/types.js';

export interface Borrador {
  contenido: string;
  tono: Tono;
  /** Variables para los parámetros {{1}}, {{2}}… de la plantilla de Meta. */
  variables: Record<string, string>;
}

export function variablesDe(db: Db, c: ClienteResumen): Record<string, string> {
  return {
    nombre: primerNombre(c.nombre),
    empresa: db.perfil.empresa,
    folio: facturasAbiertas(db, c.id).map((f) => f.folio).join(' y '),
    monto: formatMXN(c.deuda),
    dias: String(c.diasAtraso)
  };
}

export function redactar(db: Db, c: ClienteResumen, tono: Tono): Borrador {
  const variables = variablesDe(db, c);
  const plantilla = plantillas.find((p) => p.tono === tono) ?? plantillas[0];
  return { contenido: llenarPlantilla(plantilla.contenido, variables), tono, variables };
}
