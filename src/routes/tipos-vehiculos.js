const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { sanitizeIdParam } = require('../utils/sanitize');

// Middleware para verificar si el tipo de vehículo pertenece a la empresa del usuario
async function verificarPropiedadTipo(req, res, next) {
    try {
        const [tipo] = await pool.query(
            'SELECT id_tipo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ?',
            [req.params.id, req.user.id_empresa]
        );

        if (tipo.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tipo de vehículo no encontrado'
            });
        }

        next();
    } catch (error) {
        console.error('Error al verificar propiedad del tipo de vehículo:', error);
        res.status(500).json({
            success: false,
            message: 'Error al verificar propiedad del tipo de vehículo'
        });
    }
}

// Obtener todos los tipos de vehículos de la empresa
// Relacionado con: public/admin/tipos-vehiculos.html, public/js/tipos-vehiculos.js
router.get('/', verifyToken, async (req, res) => {
    try {
        const [tipos] = await pool.query(
            `SELECT tv.*, 
                    COALESCE(ct.capacidad_total, 0) as capacidad_total,
                    (SELECT COUNT(*) FROM vehiculos v WHERE v.id_tipo = tv.id_tipo AND v.id_empresa = tv.id_empresa) as total_vehiculos,
                    (SELECT COUNT(*) FROM tarifas t WHERE t.id_tipo = tv.id_tipo AND t.id_empresa = tv.id_empresa AND t.activa = TRUE) as tiene_tarifa_activa
             FROM tipos_vehiculos tv
             LEFT JOIN capacidades_tipo ct ON ct.id_tipo = tv.id_tipo AND ct.id_empresa = tv.id_empresa
             WHERE tv.id_empresa = ?
             ORDER BY tv.fecha_creacion ASC`,
            [req.user.id_empresa]
        );

        res.json({ success: true, data: tipos });
    } catch (error) {
        console.error('Error al obtener tipos de vehículos:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener los tipos de vehículos'
        });
    }
});

// Obtener tipos de vehículos activos (para uso en selectores)
// Relacionado con: public/admin/vehiculos.html, public/admin/ingreso-salida.html, public/admin/tarifas.html
router.get('/activos', verifyToken, async (req, res) => {
    try {
        const [tipos] = await pool.query(
            'SELECT id_tipo, nombre, codigo FROM tipos_vehiculos WHERE id_empresa = ? AND activo = TRUE ORDER BY nombre ASC',
            [req.user.id_empresa]
        );

        res.json({ success: true, data: tipos });
    } catch (error) {
        console.error('Error al obtener tipos activos:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener los tipos activos'
        });
    }
});

// Obtener un tipo de vehículo específico
router.get('/:id', verifyToken, sanitizeIdParam('id'), verificarPropiedadTipo, async (req, res) => {
    try {
        const [tipos] = await pool.query(
            `SELECT tv.*, COALESCE(ct.capacidad_total, 0) as capacidad_total
             FROM tipos_vehiculos tv
             LEFT JOIN capacidades_tipo ct ON ct.id_tipo = tv.id_tipo AND ct.id_empresa = tv.id_empresa
             WHERE tv.id_tipo = ? AND tv.id_empresa = ?`,
            [req.params.id, req.user.id_empresa]
        );

        if (tipos.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tipo de vehículo no encontrado'
            });
        }

        res.json({ success: true, data: tipos[0] });
    } catch (error) {
        console.error('Error al obtener tipo de vehículo:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener el tipo de vehículo'
        });
    }
});

// Crear nuevo tipo de vehículo
// Relacionado con: public/admin/tipos-vehiculos.html, public/js/tipos-vehiculos.js
router.post('/', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { nombre, codigo, capacidad_total } = req.body;

        if (!nombre || !codigo) {
            return res.status(400).json({
                success: false,
                message: 'Nombre y código son obligatorios'
            });
        }

        // Normalizar código (minúsculas, sin espacios)
        const codigoNormalizado = codigo.toLowerCase().trim().replace(/\s+/g, '_');

        // Verificar si el código ya existe en la empresa
        const [existente] = await pool.query(
            'SELECT id_tipo FROM tipos_vehiculos WHERE codigo = ? AND id_empresa = ?',
            [codigoNormalizado, req.user.id_empresa]
        );

        if (existente.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Ya existe un tipo de vehículo con este código'
            });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Insertar nuevo tipo de vehículo
            const [result] = await conn.query(
                `INSERT INTO tipos_vehiculos (id_empresa, nombre, codigo, activo)
                 VALUES (?, ?, ?, TRUE)`,
                [req.user.id_empresa, nombre.trim(), codigoNormalizado]
            );

            const idTipo = result.insertId;

            // Insertar capacidad si se proporciona
            if (capacidad_total !== undefined && capacidad_total !== null) {
                await conn.query(
                    `INSERT INTO capacidades_tipo (id_empresa, id_tipo, capacidad_total)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE capacidad_total = ?`,
                    [req.user.id_empresa, idTipo, capacidad_total, capacidad_total]
                );
            }

            await conn.commit();

            res.status(201).json({
                success: true,
                message: 'Tipo de vehículo registrado exitosamente',
                id: idTipo
            });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Error al crear tipo de vehículo:', error);
        res.status(500).json({
            success: false,
            message: 'Error al registrar el tipo de vehículo'
        });
    }
});

// Actualizar tipo de vehículo
// Relacionado con: public/admin/tipos-vehiculos.html, public/js/tipos-vehiculos.js
router.put('/:id', verifyToken, requireAdmin, sanitizeIdParam('id'), verificarPropiedadTipo, async (req, res) => {
    try {
        const { nombre, codigo, activo, capacidad_total } = req.body;

        if (!nombre) {
            return res.status(400).json({
                success: false,
                message: 'El nombre es obligatorio'
            });
        }

        // Normalizar código si se proporciona
        let codigoNormalizado = null;
        if (codigo) {
            codigoNormalizado = codigo.toLowerCase().trim().replace(/\s+/g, '_');

            // Verificar si el nuevo código ya existe (excluyendo el tipo actual)
            const [existente] = await pool.query(
                'SELECT id_tipo FROM tipos_vehiculos WHERE codigo = ? AND id_empresa = ? AND id_tipo != ?',
                [codigoNormalizado, req.user.id_empresa, req.params.id]
            );

            if (existente.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Ya existe otro tipo de vehículo con este código'
                });
            }
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Actualizar tipo de vehículo
            if (codigoNormalizado) {
                await conn.query(
                    `UPDATE tipos_vehiculos 
                     SET nombre = ?, codigo = ?, activo = ?
                     WHERE id_tipo = ? AND id_empresa = ?`,
                    [nombre.trim(), codigoNormalizado, activo !== undefined ? activo : true, req.params.id, req.user.id_empresa]
                );
            } else {
                await conn.query(
                    `UPDATE tipos_vehiculos 
                     SET nombre = ?, activo = ?
                     WHERE id_tipo = ? AND id_empresa = ?`,
                    [nombre.trim(), activo !== undefined ? activo : true, req.params.id, req.user.id_empresa]
                );
            }

            // Actualizar capacidad si se proporciona
            if (capacidad_total !== undefined && capacidad_total !== null) {
                await conn.query(
                    `INSERT INTO capacidades_tipo (id_empresa, id_tipo, capacidad_total)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE capacidad_total = ?`,
                    [req.user.id_empresa, req.params.id, capacidad_total, capacidad_total]
                );
            }

            await conn.commit();

            res.json({
                success: true,
                message: 'Tipo de vehículo actualizado exitosamente'
            });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Error al actualizar tipo de vehículo:', error);
        res.status(500).json({
            success: false,
            message: 'Error al actualizar el tipo de vehículo'
        });
    }
});

// Eliminar tipo de vehículo
// Relacionado con: public/admin/tipos-vehiculos.html, public/js/tipos-vehiculos.js
router.delete('/:id', verifyToken, requireAdmin, sanitizeIdParam('id'), verificarPropiedadTipo, async (req, res) => {
    try {
        // Verificar si el tipo tiene vehículos asociados
        const [vehiculos] = await pool.query(
            'SELECT COUNT(*) as total FROM vehiculos WHERE id_tipo = ?',
            [req.params.id]
        );

        if (vehiculos[0].total > 0) {
            return res.status(400).json({
                success: false,
                message: 'No se puede eliminar un tipo de vehículo que tiene vehículos asociados'
            });
        }

        // Verificar si tiene tarifas activas
        const [tarifas] = await pool.query(
            'SELECT COUNT(*) as total FROM tarifas WHERE id_tipo = ? AND activa = TRUE',
            [req.params.id]
        );

        if (tarifas[0].total > 0) {
            return res.status(400).json({
                success: false,
                message: 'No se puede eliminar un tipo de vehículo que tiene tarifas activas'
            });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Eliminar capacidad asociada
            await conn.query(
                'DELETE FROM capacidades_tipo WHERE id_tipo = ? AND id_empresa = ?',
                [req.params.id, req.user.id_empresa]
            );

            // Eliminar tipo de vehículo
            await conn.query(
                'DELETE FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ?',
                [req.params.id, req.user.id_empresa]
            );

            await conn.commit();

            res.json({
                success: true,
                message: 'Tipo de vehículo eliminado exitosamente'
            });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Error al eliminar tipo de vehículo:', error);
        res.status(500).json({
            success: false,
            message: 'Error al eliminar el tipo de vehículo'
        });
    }
});

module.exports = router;

